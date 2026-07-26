import { EventSourceParserStream } from 'eventsource-parser/stream';
import type { ParsedEvent } from 'eventsource-parser';

// Contract with GET /api/v1/widget/events (see backend/open_webui/routers/widget.py).
// Everything in this module is pure: no I/O, no clock, no framework — the reducer is
// the piece that would survive a move to the real generation pipeline.

export type WidgetStatus = 'starting' | 'streaming' | 'complete' | 'error';
export type WidgetStepStatus = 'running' | 'complete' | 'error';

export type WidgetStep = {
	id: string;
	label: string;
	status: WidgetStepStatus;
};

export type WidgetMetric = {
	label: string;
	value: number;
};

export type WidgetEvent =
	| { kind: 'step'; messageId: string; id: string; label: string; status: WidgetStepStatus }
	| { kind: 'metric'; messageId: string; key: string; label: string; value: number }
	| { kind: 'done'; messageId: string }
	| { kind: 'error'; messageId: string; message: string };

export type WidgetState = {
	/**
	 * Status of the scripted side channel, NOT of the answer. `widget_done` ends the
	 * stream; the model usually keeps generating well past it, so the component decides
	 * what the user is told — only the message's own `done` may claim "complete".
	 */
	status: WidgetStatus;
	steps: WidgetStep[];
	metrics: Record<string, WidgetMetric>;
	startedAt: number;
	/** When the scripted stream stopped producing frames. */
	finishedAt?: number;
	/**
	 * When the generation itself ended — the session's real end, and what elapsed time
	 * is measured against. Usually much later than `finishedAt`. Write-once.
	 */
	endedAt?: number;
	errorMessage?: string;
};

export const widgetKey = (chatId: string, messageId: string) => `${chatId}:${messageId}`;

export const isTerminal = (status: WidgetStatus) => status === 'complete' || status === 'error';

export const initialWidgetState = (startedAt: number): WidgetState => ({
	status: 'starting',
	steps: [],
	metrics: {},
	startedAt
});

const STEP_STATUSES: WidgetStepStatus[] = ['running', 'complete', 'error'];

/**
 * What the user is told — not the same thing as what the stream is doing. The scripted
 * stream ends at `widget_done`, routinely long before the answer does, so only the
 * message's own `done` may report completion. In the gap the session is still streaming.
 */
export const widgetDisplayStatus = (
	streamStatus: WidgetStatus,
	done: boolean,
	errored: boolean
): WidgetStatus => {
	if (streamStatus === 'error' || errored) return 'error';
	if (done) return 'complete';
	return streamStatus === 'complete' ? 'streaming' : streamStatus;
};

export const isWidgetActive = (displayStatus: WidgetStatus) =>
	displayStatus === 'starting' || displayStatus === 'streaming';

/**
 * How long the session has run. While active it tracks `now`; once ended it uses
 * `endedAt`, the generation's end.
 *
 * It deliberately never falls back to `finishedAt`. That is the scripted stream's end,
 * and reaching for it whenever `endedAt` had not yet propagated displayed a 33s session
 * as 6s — the timer visibly jumping backwards at the moment generation completed.
 * Falling back to `now` is correct in exactly that window, because the session is only
 * unstamped while it is still ending.
 */
export const widgetElapsedMs = (
	state: WidgetState | undefined,
	active: boolean,
	now: number
): number => {
	if (!state) return 0;
	const endedAt = active ? now : (state.endedAt ?? now);
	return Math.max(0, endedAt - state.startedAt);
};

/**
 * Reader over an SSE response body. Extracted so the transport layer is one call and
 * the parser below can be tested against plain strings.
 */
export const getSSEEventReader = (body: ReadableStream<Uint8Array>) =>
	body
		.pipeThrough(new TextDecoderStream())
		.pipeThrough(new EventSourceParserStream())
		.getReader() as ReadableStreamDefaultReader<ParsedEvent>;

/**
 * Turns one raw SSE frame into a typed event. Never throws — anything malformed,
 * unknown, or missing a messageId returns null and is dropped by the caller.
 */
export const parseWidgetEvent = (
	eventName: string | undefined,
	rawData: string
): WidgetEvent | null => {
	if (!eventName) return null;
	if (eventName !== 'widget_delta' && eventName !== 'widget_done' && eventName !== 'widget_error') {
		return null;
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawData);
	} catch {
		return null;
	}
	if (typeof payload !== 'object' || payload === null) return null;

	const data = payload as Record<string, unknown>;
	const messageId = data.messageId;
	if (typeof messageId !== 'string' || messageId === '') return null;

	if (eventName === 'widget_done') {
		return { kind: 'done', messageId };
	}

	if (eventName === 'widget_error') {
		return {
			kind: 'error',
			messageId,
			message: typeof data.message === 'string' ? data.message : 'Stream failed'
		};
	}

	if (data.type === 'step') {
		const { id, label, status } = data;
		if (typeof id !== 'string' || typeof label !== 'string') return null;
		if (!STEP_STATUSES.includes(status as WidgetStepStatus)) return null;
		return { kind: 'step', messageId, id, label, status: status as WidgetStepStatus };
	}

	if (data.type === 'metric') {
		const { key, label, value } = data;
		if (typeof key !== 'string' || typeof label !== 'string') return null;
		if (typeof value !== 'number' || !Number.isFinite(value)) return null;
		return { kind: 'metric', messageId, key, label, value };
	}

	return null;
};

/**
 * Pure reducer. Upserts are idempotent, so a duplicated frame leaves state deep-equal,
 * and anything arriving after a terminal status is ignored.
 */
export const widgetReducer = (state: WidgetState, event: WidgetEvent): WidgetState => {
	if (isTerminal(state.status)) return state;

	switch (event.kind) {
		case 'done':
			return { ...state, status: 'complete' };

		case 'error':
			return { ...state, status: 'error', errorMessage: event.message };

		case 'step': {
			const index = state.steps.findIndex((step) => step.id === event.id);
			const next: WidgetStep = { id: event.id, label: event.label, status: event.status };
			if (index !== -1) {
				const existing = state.steps[index];
				if (existing.label === next.label && existing.status === next.status) {
					return state.status === 'streaming' ? state : { ...state, status: 'streaming' };
				}
				const steps = state.steps.slice();
				steps[index] = next;
				return { ...state, status: 'streaming', steps };
			}
			return { ...state, status: 'streaming', steps: [...state.steps, next] };
		}

		case 'metric': {
			const existing = state.metrics[event.key];
			if (existing && existing.label === event.label && existing.value === event.value) {
				return state.status === 'streaming' ? state : { ...state, status: 'streaming' };
			}
			return {
				...state,
				status: 'streaming',
				metrics: { ...state.metrics, [event.key]: { label: event.label, value: event.value } }
			};
		}
	}
};
