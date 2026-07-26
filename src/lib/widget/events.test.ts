import { describe, expect, it } from 'vitest';

import {
	getSSEEventReader,
	initialWidgetState,
	isWidgetActive,
	parseWidgetEvent,
	widgetDisplayStatus,
	widgetElapsedMs,
	widgetKey,
	widgetReducer,
	type WidgetEvent,
	type WidgetState
} from './events';

/**
 * Serves `text` as a Uint8Array stream cut into `size`-byte chunks, so SSE frames land
 * split across chunk boundaries the way a real network read does.
 */
const chunkedStream = (text: string, size: number): ReadableStream<Uint8Array> => {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		}
	});
};

const readAll = async (body: ReadableStream<Uint8Array>) => {
	const reader = getSSEEventReader(body);
	const frames: { event?: string; data: string }[] = [];
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		if (value) frames.push({ event: value.event, data: value.data });
	}
	return frames;
};

const step = (id: string, label: string, status: 'running' | 'complete' | 'error') =>
	`event: widget_delta\ndata: ${JSON.stringify({ messageId: 'm1', type: 'step', id, label, status })}\n\n`;

const reduceAll = (events: WidgetEvent[], from: WidgetState = initialWidgetState(0)) =>
	events.reduce(widgetReducer, from);

describe('widgetKey', () => {
	it('joins chat and message ids', () => {
		expect(widgetKey('c1', 'm1')).toBe('c1:m1');
	});
});

describe('getSSEEventReader', () => {
	it('parses frames split across chunk boundaries', async () => {
		const body =
			step('parse', 'Parsing request', 'running') +
			step('parse', 'Parsing request', 'complete') +
			`event: widget_done\ndata: ${JSON.stringify({ messageId: 'm1' })}\n\n`;

		// One byte at a time: every frame is split, including mid-JSON and mid-field-name.
		const frames = await readAll(chunkedStream(body, 1));

		expect(frames.map((f) => f.event)).toEqual(['widget_delta', 'widget_delta', 'widget_done']);
		expect(parseWidgetEvent(frames[0].event, frames[0].data)).toEqual({
			kind: 'step',
			messageId: 'm1',
			id: 'parse',
			label: 'Parsing request',
			status: 'running'
		});
		expect(parseWidgetEvent(frames[2].event, frames[2].data)).toEqual({
			kind: 'done',
			messageId: 'm1'
		});
	});
});

describe('parseWidgetEvent', () => {
	it('parses step, metric, done and error frames', () => {
		expect(
			parseWidgetEvent(
				'widget_delta',
				'{"messageId":"m1","type":"metric","key":"sources","label":"Sources","value":3}'
			)
		).toEqual({ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 3 });

		expect(
			parseWidgetEvent('widget_error', '{"messageId":"m1","message":"Retrieval unavailable"}')
		).toEqual({ kind: 'error', messageId: 'm1', message: 'Retrieval unavailable' });
	});

	it('returns null for malformed and unknown frames instead of throwing', () => {
		const bad: [string | undefined, string][] = [
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank"'], // truncated JSON
			['widget_delta', 'not json at all'],
			['widget_delta', '{"type":"step","id":"rank","label":"Rank","status":"running"}'], // no messageId
			['widget_delta', '{"messageId":"m1","type":"telemetry","value":1}'], // unknown type
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank","label":"Rank"}'], // no status
			['widget_delta', '{"messageId":"m1","type":"step","id":"rank","label":"R","status":"weird"}'],
			['widget_delta', '{"messageId":"m1","type":"metric","key":"s","label":"S","value":"3"}'],
			['chat:completion', '{"messageId":"m1"}'], // unrelated event name
			[undefined, '{"messageId":"m1"}'] // unnamed frame
		];

		for (const [name, data] of bad) {
			expect(parseWidgetEvent(name, data), `${name} / ${data}`).toBeNull();
		}
	});
});

// These two derive what the user actually sees. Both regressed while they lived inline
// in the component, where nothing could test them, so they live here now.
describe('widgetDisplayStatus', () => {
	it('does not report complete just because the scripted stream ended', () => {
		// The stream finishes in ~7s; the answer often needs far longer. Claiming
		// "complete" here showed Complete ~30s before the answer stopped arriving.
		expect(widgetDisplayStatus('complete', false, false)).toBe('streaming');
		expect(isWidgetActive(widgetDisplayStatus('complete', false, false))).toBe(true);
	});

	it('reports complete only once the generation is done', () => {
		expect(widgetDisplayStatus('complete', true, false)).toBe('complete');
		expect(widgetDisplayStatus('streaming', true, false)).toBe('complete');
		expect(isWidgetActive('complete')).toBe(false);
	});

	it('lets either the stream or the message raise an error', () => {
		expect(widgetDisplayStatus('error', false, false)).toBe('error');
		expect(widgetDisplayStatus('streaming', false, true)).toBe('error');
		expect(widgetDisplayStatus('complete', true, true)).toBe('error');
	});

	it('passes through the pre-terminal statuses untouched', () => {
		expect(widgetDisplayStatus('starting', false, false)).toBe('starting');
		expect(widgetDisplayStatus('streaming', false, false)).toBe('streaming');
	});
});

describe('widgetElapsedMs', () => {
	const ended: WidgetState = {
		status: 'complete',
		steps: [],
		metrics: {},
		startedAt: 1_000,
		finishedAt: 7_800, // the scripted stream stopped here
		endedAt: 34_400 // the generation stopped here
	};

	it('measures the generation, never the scripted stream', () => {
		expect(widgetElapsedMs(ended, false, 99_000)).toBe(33_400);
	});

	it('falls back to now — not to the stream — while the end is still propagating', () => {
		// The instant generation stops, the store write has not reached this state yet.
		// Reaching for finishedAt here is what displayed a 33s session as 6s.
		const unstamped: WidgetState = { ...ended, endedAt: undefined };
		expect(widgetElapsedMs(unstamped, false, 34_400)).toBe(33_400);
	});

	it('tracks now while the session is still running', () => {
		expect(widgetElapsedMs({ ...ended, endedAt: undefined }, true, 21_000)).toBe(20_000);
		// An already-stamped end is ignored while active — continue-response restarts.
		expect(widgetElapsedMs(ended, true, 40_000)).toBe(39_000);
	});

	it('is zero without state and never negative', () => {
		expect(widgetElapsedMs(undefined, true, 5_000)).toBe(0);
		expect(widgetElapsedMs(ended, true, 0)).toBe(0);
	});
});

describe('widgetReducer', () => {
	it('moves starting -> streaming on the first delta', () => {
		const state = initialWidgetState(1000);
		expect(state.status).toBe('starting');

		const next = widgetReducer(state, {
			kind: 'step',
			messageId: 'm1',
			id: 'parse',
			label: 'Parsing',
			status: 'running'
		});
		expect(next.status).toBe('streaming');
		expect(next.startedAt).toBe(1000);
	});

	it('upserts steps in first-seen order and metrics by key', () => {
		const state = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'running' },
			{ kind: 'step', messageId: 'm1', id: 'search', label: 'Searching', status: 'running' },
			{ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 2 },
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' },
			{ kind: 'metric', messageId: 'm1', key: 'sources', label: 'Sources', value: 5 }
		]);

		expect(state.steps).toEqual([
			{ id: 'parse', label: 'Parsing', status: 'complete' },
			{ id: 'search', label: 'Searching', status: 'running' }
		]);
		expect(state.metrics).toEqual({ sources: { label: 'Sources', value: 5 } });
	});

	it('is idempotent for a duplicated step frame', () => {
		const frame: WidgetEvent = {
			kind: 'step',
			messageId: 'm1',
			id: 'search',
			label: 'Searching',
			status: 'running'
		};
		const once = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' },
			frame
		]);
		const twice = widgetReducer(once, frame);

		expect(twice).toEqual(once);
		expect(twice.steps).toHaveLength(2);
	});

	it('finishes on done and on error, and ignores anything after a terminal status', () => {
		const streaming = reduceAll([
			{ kind: 'step', messageId: 'm1', id: 'parse', label: 'Parsing', status: 'complete' }
		]);

		const completed = widgetReducer(streaming, { kind: 'done', messageId: 'm1' });
		expect(completed.status).toBe('complete');

		const errored = widgetReducer(streaming, {
			kind: 'error',
			messageId: 'm1',
			message: 'Retrieval unavailable'
		});
		expect(errored.status).toBe('error');
		expect(errored.errorMessage).toBe('Retrieval unavailable');

		// A late delta must not reopen a finished widget.
		const late = widgetReducer(completed, {
			kind: 'step',
			messageId: 'm1',
			id: 'zombie',
			label: 'Zombie',
			status: 'running'
		});
		expect(late).toBe(completed);
		expect(widgetReducer(errored, { kind: 'done', messageId: 'm1' })).toBe(errored);
	});
});
