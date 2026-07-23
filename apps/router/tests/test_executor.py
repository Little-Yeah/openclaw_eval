from pinch_router.executor import provider_messages
from pinch_router.schemas import TraceInput


def test_provider_message_mapping_keeps_content_and_normalizes_roles() -> None:
    trace = TraceInput.model_validate(
        {
            "messages": [
                {"role": "developer", "content": "be concise"},
                {"role": "tool", "content": "command completed"},
                {"role": "user", "content": "summarize"},
            ]
        }
    )
    assert provider_messages(trace) == [
        {"role": "system", "content": "be concise"},
        {"role": "user", "content": "command completed"},
        {"role": "user", "content": "summarize"},
    ]
