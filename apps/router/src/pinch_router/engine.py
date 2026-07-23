from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as functional
from transformers import AutoModel, AutoTokenizer

from .context import RoutingContext
from .executor import ModelExecution, ProviderExecutor
from .schemas import ModelConfig, RouterConfig, TraceInput


class QualityPredictor(nn.Module):
    def __init__(self, feature_dim: int, model_count: int) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        previous = feature_dim + 384
        for hidden in (512, 256, 128):
            layers.extend((nn.Linear(previous, hidden), nn.BatchNorm1d(hidden), nn.ReLU(), nn.Dropout(0.2)))
            previous = hidden
        layers.append(nn.Linear(previous, 1))
        self.net = nn.Sequential(*layers)
        self.llm_bias = nn.Parameter(torch.zeros(model_count))
        self.llm_vector_bias = nn.Parameter(torch.zeros(model_count, 384))

    def forward(self, features: torch.Tensor, embeddings: torch.Tensor, indices: torch.Tensor) -> torch.Tensor:
        candidate_count = embeddings.size(0)
        biased = embeddings + self.llm_vector_bias[indices]
        combined = torch.cat(
            (features.unsqueeze(1).expand(-1, candidate_count, -1), biased.unsqueeze(0).expand(features.size(0), -1, -1)),
            dim=2,
        ).reshape(-1, features.size(1) + 384)
        output = self.net(combined).view(features.size(0), candidate_count)
        output = output + self.llm_bias[indices].unsqueeze(0)
        return 0.5 * (torch.tanh(0.5 * output) + 1.0)


class CostPredictor(nn.Module):
    def __init__(self, feature_dim: int, model_count: int) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        previous = feature_dim + 384
        for hidden in (256, 128, 64):
            layers.extend((nn.Linear(previous, hidden), nn.ReLU()))
            previous = hidden
        layers.append(nn.Linear(previous, 1))
        self.net = nn.Sequential(*layers)
        self.llm_vector_bias = nn.Parameter(torch.zeros(model_count, 384))

    def forward(self, features: torch.Tensor, embeddings: torch.Tensor, indices: torch.Tensor) -> torch.Tensor:
        candidate_count = embeddings.size(0)
        biased = embeddings + self.llm_vector_bias[indices]
        combined = torch.cat(
            (features.unsqueeze(1).expand(-1, candidate_count, -1), biased.unsqueeze(0).expand(features.size(0), -1, -1)),
            dim=2,
        ).reshape(-1, features.size(1) + 384)
        return functional.softplus(self.net(combined)).view(features.size(0), candidate_count)


@dataclass(frozen=True)
class CandidatePrediction:
    label: str
    probability: float
    score: float
    predicted_quality: float
    predicted_output_tokens: float
    predicted_cost: float


@dataclass(frozen=True)
class RouteResult:
    selected_label: str
    candidates: list[CandidatePrediction]
    routing_context: str
    actual_input_tokens: int
    router_latency_ms: int


class CheckpointRouter:
    def __init__(self, assets_dir: Path, config_path: Path, *, device: str = "cpu") -> None:
        self.device = torch.device(device)
        self.assets_dir = assets_dir
        self.config = RouterConfig.model_validate_json(config_path.read_text())
        self.models = {model.label: model for model in self.config.models}
        self.canonical_labels = list(self.config.default_candidates)
        self.canonical_index = {label: index for index, label in enumerate(self.canonical_labels)}
        self._validate_config()

        representation_file = assets_dir / "runtime_model_representations.npz"
        data = np.load(representation_file, allow_pickle=False)
        representation_by_name = dict(zip(data["model_names"].tolist(), data["vectors"].tolist(), strict=True))
        self.representations = {
            label: np.asarray(representation_by_name[model.representation_name], dtype=np.float32)
            for label, model in self.models.items()
        }

        encoder_path = assets_dir / "chinese_mobilebert_base_f2"
        self.tokenizer = AutoTokenizer.from_pretrained(encoder_path, local_files_only=True)
        self.encoder = AutoModel.from_pretrained(encoder_path, local_files_only=True).to(self.device).eval()
        hidden_size = int(self.encoder.config.hidden_size)
        self.quality = QualityPredictor(hidden_size, len(self.canonical_labels)).to(self.device)
        self.cost = CostPredictor(hidden_size, len(self.canonical_labels)).to(self.device)
        checkpoint = torch.load(assets_dir / "best_router_finetuned.pth", map_location=self.device, weights_only=True)
        self._load_checkpoint(checkpoint)
        self.quality.eval()
        self.cost.eval()

    def _validate_config(self) -> None:
        if len(self.canonical_labels) != len(set(self.canonical_labels)):
            raise ValueError("default_candidates must not contain duplicate labels")
        missing = set(self.canonical_labels) - self.models.keys()
        if missing:
            raise ValueError(f"default_candidates missing model definitions: {sorted(missing)}")
        missing_profiles = {model.execution_profile for model in self.models.values()} - self.config.execution_profiles.keys()
        if missing_profiles:
            raise ValueError(f"models reference unknown execution profiles: {sorted(missing_profiles)}")

    def _load_checkpoint(self, checkpoint: dict[str, torch.Tensor]) -> None:
        quality_state = {key.removeprefix("quality_predictor."): value for key, value in checkpoint.items() if key.startswith("quality_predictor.")}
        cost_state = {key.removeprefix("cost_predictor."): value for key, value in checkpoint.items() if key.startswith("cost_predictor.")}
        if not quality_state or not cost_state:
            raise ValueError("checkpoint does not contain router prediction heads")
        self.quality.load_state_dict(quality_state, strict=True)
        self.cost.load_state_dict(cost_state, strict=True)

    def _encode(self, text: str) -> tuple[torch.Tensor, int]:
        encoded = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        input_tokens = int(encoded["attention_mask"].sum().item())
        encoded = {key: value.to(self.device) for key, value in encoded.items()}
        with torch.inference_mode():
            states = self.encoder(**encoded).last_hidden_state
            mask = encoded["attention_mask"].unsqueeze(-1)
            features = (states * mask).sum(dim=1) / mask.sum(dim=1).clamp(min=1)
        return features, input_tokens

    @staticmethod
    def _score(quality: float, cost: float, preference: int, costs: list[float], qualities: list[float]) -> float:
        quality_span = max(qualities) - min(qualities)
        cost_span = max(costs) - min(costs)
        normalized_quality = (quality - min(qualities)) / quality_span if quality_span else 1.0
        normalized_cost = 1.0 - ((cost - min(costs)) / cost_span) if cost_span else 1.0
        quality_weight = {1: 1.0, 2: 0.8, 3: 0.6, 4: 0.4, 5: 0.2, 6: 0.0}[preference]
        return quality_weight * normalized_quality + (1.0 - quality_weight) * normalized_cost

    def route(self, trace: TraceInput, context: RoutingContext) -> RouteResult:
        started = time.perf_counter()
        labels = trace.candidate_labels or self.config.default_candidates
        unknown = set(labels) - self.models.keys()
        if unknown:
            raise ValueError(f"unknown candidate labels: {sorted(unknown)}")
        unsupported = set(labels) - self.canonical_index.keys()
        if unsupported:
            raise ValueError(f"checkpoint has no learned bias for: {sorted(unsupported)}")

        features, routing_input_tokens = self._encode(context.text)
        actual_input_tokens = trace.actual_input_tokens if trace.actual_input_tokens is not None else routing_input_tokens
        indices = torch.tensor([self.canonical_index[label] for label in labels], dtype=torch.long, device=self.device)
        embeddings = torch.tensor(np.stack([self.representations[label] for label in labels]), device=self.device)
        with torch.inference_mode():
            qualities = self.quality(features, embeddings, indices)[0].tolist()
            output_tokens = self.cost(features, embeddings, indices)[0].tolist()

        predicted_costs = [
            actual_input_tokens * self.models[label].input_price_per_million / 1_000_000
            + tokens * self.models[label].output_price_per_million / 1_000_000
            for label, tokens in zip(labels, output_tokens, strict=True)
        ]
        scores = [self._score(quality, cost, trace.preference, predicted_costs, qualities) for quality, cost in zip(qualities, predicted_costs, strict=True)]
        probabilities = torch.softmax(torch.tensor(scores), dim=0).tolist()
        predictions = sorted(
            [
                CandidatePrediction(label, probability, score, quality, tokens, cost)
                for label, probability, score, quality, tokens, cost in zip(labels, probabilities, scores, qualities, output_tokens, predicted_costs, strict=True)
            ],
            key=lambda item: item.score,
            reverse=True,
        )
        return RouteResult(
            selected_label=predictions[0].label,
            candidates=predictions,
            routing_context=context.text,
            actual_input_tokens=actual_input_tokens,
            router_latency_ms=round((time.perf_counter() - started) * 1000),
        )

    def execute_selected(self, route_result: RouteResult, trace: TraceInput) -> ModelExecution:
        profile_name = self.models[route_result.selected_label].execution_profile
        profile = self.config.execution_profiles[profile_name]
        return ProviderExecutor(profile_name, profile).execute(trace)


def result_as_json(result: RouteResult) -> str:
    return json.dumps(
        {
            "selected_label": result.selected_label,
            "actual_input_tokens": result.actual_input_tokens,
            "router_latency_ms": result.router_latency_ms,
            "routing_context": result.routing_context,
            "candidates": [candidate.__dict__ for candidate in result.candidates],
        },
        ensure_ascii=False,
        indent=2,
    )


def execution_as_json(route_result: RouteResult, execution: ModelExecution) -> str:
    payload = json.loads(result_as_json(route_result))
    payload["execution"] = execution.__dict__
    return json.dumps(payload, ensure_ascii=False, indent=2)
