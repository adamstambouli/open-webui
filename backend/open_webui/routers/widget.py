"""Dev-only SSE side channel for the live session widget.

The real generation pipeline streams over Socket.IO (``chat:completion``); this
endpoint is a deterministic scripted stand-in so the widget's streaming, error and
resilience behaviour can be demonstrated and curl-tested without a live RAG stack.
Registered from ``main.py`` only when ``ENV == 'dev'``.
"""

from __future__ import annotations

import asyncio
import hashlib
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


def _source(n: int, title: str, url: str) -> dict:
    return {'type': 'source', 'n': n, 'title': title, 'url': url}


# The collections a retrieval step can search. Which pair a message gets is seeded from
# its id, so the demo varies between messages while staying reproducible for any one.
_COLLECTIONS = [
    ('courses', 'Searching course materials'),
    ('research', 'Searching research repositories'),
    ('patents', 'Searching IP & patents'),
    ('projects', 'Cross-referencing active projects'),
]

# Per-collection source pools. Which two collections a message searches is seeded, so
# these titles vary with it while staying reproducible for any one message.
_SOURCE_POOL: dict[str, list[tuple[str, str]]] = {
    'courses': [
        (
            'BMGT808 · Venture Capital Deal Design — Week 4 notes',
            'https://courses.xfoundry.umd.edu/bmgt808/week-4',
        ),
        (
            'ENES460 · Technology Commercialization — case pack',
            'https://courses.xfoundry.umd.edu/enes460/cases',
        ),
        (
            'BMGT390 · Term sheet teardown — seminar recording',
            'https://courses.xfoundry.umd.edu/bmgt390/seminar-9',
        ),
    ],
    'research': [
        (
            'Hydrogel-based water filtration — lab notebook',
            'https://research.xfoundry.umd.edu/hydrogel/notebook',
        ),
        (
            'Membrane fouling under variable flux — dataset README',
            'https://research.xfoundry.umd.edu/membrane-fouling',
        ),
        (
            'Grant report: point-of-use filtration pilot',
            'https://research.xfoundry.umd.edu/reports/pou-pilot',
        ),
    ],
    'patents': [
        ('Provisional patent draft 63/482,119', 'https://ip.xfoundry.umd.edu/provisional/63-482119'),
        ('Freedom-to-operate memo — filtration media', 'https://ip.xfoundry.umd.edu/fto/filtration'),
        ('Invention disclosure IDF-2024-0417', 'https://ip.xfoundry.umd.edu/idf/2024-0417'),
    ],
    'projects': [
        ('Project Clearwater — milestone review', 'https://fibery.xfoundry.umd.edu/clearwater/m3'),
        ('Cohort 12 · team staffing plan', 'https://fibery.xfoundry.umd.edu/cohort-12/staffing'),
        ('Partner pipeline — Q3 summary', 'https://fibery.xfoundry.umd.edu/pipeline/q3'),
    ],
}

_ERROR_MESSAGE = 'Retrieval backend unavailable'


def _seed(message_id: str) -> int:
    """Stable across processes and restarts, unlike hash()."""
    return int(hashlib.sha256(message_id.encode()).hexdigest(), 16)


def build_script(message_id: str, scenario: str) -> list[tuple[float, str, dict | str]]:
    """Build the frame script for one message.

    Pure and deterministic: the same message_id always yields byte-identical frames
    (the delays are cadence only and are not part of that claim). Randomising instead
    would have cost the brief's deterministic mock endpoint; seeding buys variety
    without it, and lets this be asserted without running the streaming machinery.

    Every variant keeps the duplicate frame and the malformed raw line — the resilience
    the widget is built to absorb must be visible in any demo, not just a lucky one.
    """
    seed = _seed(message_id)
    first_key, first_label = _COLLECTIONS[seed % len(_COLLECTIONS)]
    second_key, second_label = _COLLECTIONS[(seed // len(_COLLECTIONS)) % len(_COLLECTIONS)]
    if second_key == first_key:  # never search the same collection twice
        second_key, second_label = _COLLECTIONS[(seed + 1) % len(_COLLECTIONS)]

    first_sources = 2 + seed % 3  # 2-4
    total_sources = first_sources + 3 + (seed // 7) % 4  # first + 3-6
    confidence = round(0.78 + (seed % 17) / 100, 2)  # 0.78-0.94

    # Two sources from the first collection, one from the second — cited [1][2][3] in the
    # UI. The `sources` count metric stays alongside them for backward compatibility.
    first_pool = _SOURCE_POOL[first_key]
    second_pool = _SOURCE_POOL[second_key]
    citations = [
        first_pool[seed % len(first_pool)],
        first_pool[(seed + 1) % len(first_pool)],
        second_pool[(seed // 3) % len(second_pool)],
    ]

    script: list[tuple[float, str, dict | str]] = [
        (0.3, 'widget_delta', _step('parse', 'Parsing query', 'running')),
        (0.4, 'widget_delta', _step('parse', 'Parsing query', 'complete')),
        (0.3, 'widget_delta', _step(first_key, first_label, 'running')),
        (0.4, 'widget_delta', _source(1, *citations[0])),
        (0.3, 'widget_delta', _source(2, *citations[1])),
        (0.5, 'widget_delta', _metric('sources', 'Sources', first_sources)),
        (0.4, 'widget_delta', _step(first_key, first_label, 'complete')),
        (0.3, 'widget_delta', _step(second_key, second_label, 'running')),
        # Exact duplicate of the frame above — the reducer must treat it as a no-op.
        (0.4, 'widget_delta', _step(second_key, second_label, 'running')),
        (0.4, 'widget_delta', _source(3, *citations[2])),
        (0.5, 'widget_delta', _metric('sources', 'Sources', total_sources)),
        # Valid SSE framing, truncated JSON body — the parser must drop it and carry on.
        (0.3, 'widget_delta', '{"messageId":"__MESSAGE_ID__","type":"step","id":"trunca'),
        (0.4, 'widget_delta', _step(second_key, second_label, 'complete')),
    ]

    # scenario=error stops here and fails instead of completing.
    if scenario == 'error':
        return script

    script += [
        (0.5, 'widget_delta', _step('rank', 'Ranking sources', 'running')),
        (0.4, 'widget_delta', _metric('confidence', 'Confidence', confidence)),
        (0.3, 'widget_delta', _step('rank', 'Ranking sources', 'complete')),
        (0.5, 'widget_delta', _step('generate', 'Generating answer', 'running')),
        (0.4, 'widget_delta', _step('generate', 'Generating answer', 'complete')),
    ]
    return script


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
        for delay, event, payload in build_script(message_id, scenario):
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
