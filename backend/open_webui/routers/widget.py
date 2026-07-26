"""Dev-only SSE side channel for the live session widget.

The real generation pipeline streams over Socket.IO (``chat:completion``); this
endpoint is a deterministic scripted stand-in so the widget's streaming, error and
resilience behaviour can be demonstrated and curl-tested without a live RAG stack.
Registered from ``main.py`` only when ``ENV == 'dev'``.
"""

from __future__ import annotations

import asyncio
import json
import logging

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from open_webui.constants import ERROR_MESSAGES
from open_webui.models.chats import Chats
from open_webui.socket.main import broadcast_chat_session_status
from open_webui.utils.auth import get_verified_user

log = logging.getLogger(__name__)

router = APIRouter()


def _step(step_id: str, label: str, status_: str) -> dict:
    return {'type': 'step', 'id': step_id, 'label': label, 'status': status_}


def _metric(key: str, label: str, value: float) -> dict:
    return {'type': 'metric', 'key': key, 'label': label, 'value': value}


# (delay before emitting, event name, payload). A payload that is already a string is
# yielded raw — that is how the deliberately malformed frame gets onto the wire.
_SCRIPT: list[tuple[float, str, dict | str]] = [
    (0.3, 'widget_delta', _step('parse', 'Parsing request', 'running')),
    (0.4, 'widget_delta', _step('parse', 'Parsing request', 'complete')),
    (0.3, 'widget_delta', _step('search_courses', 'Searching course docs', 'running')),
    (0.5, 'widget_delta', _metric('sources', 'Sources', 2)),
    (0.4, 'widget_delta', _step('search_courses', 'Searching course docs', 'complete')),
    (0.3, 'widget_delta', _step('search_repos', 'Searching repositories', 'running')),
    # Exact duplicate of the frame above — the reducer must treat it as a no-op.
    (0.4, 'widget_delta', _step('search_repos', 'Searching repositories', 'running')),
    (0.5, 'widget_delta', _metric('sources', 'Sources', 5)),
    # Valid SSE framing, truncated JSON body — the parser must drop it and carry on.
    (0.3, 'widget_delta', '{"messageId":"__MESSAGE_ID__","type":"step","id":"search_re'),
    (0.4, 'widget_delta', _step('search_repos', 'Searching repositories', 'complete')),
    (0.5, 'widget_delta', _step('rank', 'Ranking passages', 'running')),
    (0.4, 'widget_delta', _metric('confidence', 'Confidence', 0.87)),
    (0.3, 'widget_delta', _step('rank', 'Ranking passages', 'complete')),
    (0.5, 'widget_delta', _step('generate', 'Generating answer', 'running')),
    (0.7, 'widget_delta', _metric('sources', 'Sources', 7)),
    (0.4, 'widget_delta', _step('generate', 'Generating answer', 'complete')),
]

# scenario=error cuts the script short and fails instead of completing.
_ERROR_AFTER_INDEX = 9  # through the search_repos completion
_ERROR_MESSAGE = 'Retrieval backend unavailable'


def _frame(event: str, payload: dict | str, message_id: str) -> str:
    if isinstance(payload, str):
        data = payload.replace('__MESSAGE_ID__', message_id)
    else:
        data = json.dumps({'messageId': message_id, **payload})
    return f'event: {event}\ndata: {data}\n\n'


async def _widget_event_stream(chat_id: str, message_id: str, scenario: str):
    # Tell every viewer of this chat that a session is live before the first frame.
    await broadcast_chat_session_status(chat_id, 'streaming')
    try:
        script = _SCRIPT[: _ERROR_AFTER_INDEX + 1] if scenario == 'error' else _SCRIPT
        for delay, event, payload in script:
            await asyncio.sleep(delay)
            yield _frame(event, payload, message_id)

        if scenario == 'error':
            yield _frame('widget_error', {'message': _ERROR_MESSAGE}, message_id)
        else:
            yield _frame('widget_done', {}, message_id)
    finally:
        # Runs on natural completion AND on client cancellation (the component aborts
        # as soon as the real answer finishes, which is usually before this script
        # ends). Without it every other viewer keeps a stale "streaming" badge.
        #
        # The shield is load-bearing on the cancellation path: starlette streams inside
        # an anyio cancel scope, so a plain `await` here is re-cancelled at once and the
        # emit never lands (verified). move_on_after bounds the shielded work so a wedged
        # emit cannot hold the connection open.
        with anyio.move_on_after(2, shield=True):
            await broadcast_chat_session_status(chat_id, 'complete')


@router.get('/events')
async def widget_events(
    chat_id: str = Query(...),
    message_id: str = Query(...),
    scenario: str = Query('happy', pattern='^(happy|error)$'),
    user=Depends(get_verified_user),
):
    """Scripted ``widget_delta`` stream for one message of a chat the caller owns."""
    if not await Chats.is_chat_owner(chat_id, user.id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=ERROR_MESSAGES.ACCESS_PROHIBITED,
        )

    return StreamingResponse(
        _widget_event_stream(chat_id, message_id, scenario),
        media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )
