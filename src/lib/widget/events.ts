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
	/** Stamped on entering `running`, and on leaving it — the pair gives the duration. */
	startedAt?: number;
	endedAt?: number;
};

/** A retrieved source, numbered so the UI can cite it compactly as [1][2][3]. */
export type WidgetSource = {
	n: number;
	title: string;
	url: string;
};

export type WidgetMetric = {
	label: string;
	value: number;
};

export type WidgetEvent =
	| { kind: 'step'; messageId: string; id: string; label: string; status: WidgetStepStatus }
	| { kind: 'metric'; messageId: string; key: string; label: string; value: number }
	| { kind: 'source'; messageId: string; n: number; title: string; url: string }
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
	sources: WidgetSource[];
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
	sources: [],
	metrics: {},
	startedAt
});

const STEP_STATUSES: WidgetStepStatus[] = ['running', 'complete', 'error'];

/**
 * A finished session, persisted onto the message so a reload still shows the trace.
 * Versioned because it outlives the code that wrote it.
 *
 * The type narrows what `WidgetState` leaves open: a snapshot is terminal by definition
 * and always knows when its session ended, so those stop being optional here rather than
 * letting the type vouch for something `hydrateWidgetState` would reject.
 */
export type WidgetSnapshot = Omit<WidgetState, 'status' | 'endedAt'> & {
	v: 1;
	status: 'complete' | 'error';
	endedAt: number;
};

export const SNAPSHOT_VERSION = 1;

/** Only terminal sessions are worth persisting; an in-flight one would reload as a lie. */
export const snapshotWidgetState = (state: WidgetState): WidgetSnapshot | null =>
	(state.status === 'complete' || state.status === 'error') && state.endedAt !== undefined
		? { ...state, status: state.status, endedAt: state.endedAt, v: SNAPSHOT_VERSION }
		: null;

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

/**
 * Reads a snapshot back off a message. Defensive in the same spirit as the SSE parser:
 * this is user-editable stored JSON from an unknown past version, so it never throws and
 * returns null for anything it cannot fully vouch for. A rejected snapshot leaves the
 * widget absent, which is honest; a half-trusted one would render a broken trace.
 */
export const hydrateWidgetState = (raw: unknown): WidgetState | null => {
	if (typeof raw !== 'object' || raw === null) return null;
	const data = raw as Record<string, unknown>;

	if (data.v !== SNAPSHOT_VERSION) return null;
	if (data.status !== 'complete' && data.status !== 'error') return null;
	if (!isFiniteNumber(data.startedAt) || !isFiniteNumber(data.endedAt)) return null;
	// A session cannot end before it began, and the stream cannot outlast the session.
	if (data.endedAt < data.startedAt) return null;
	if (data.finishedAt !== undefined) {
		if (!isFiniteNumber(data.finishedAt)) return null;
		if (data.finishedAt < data.startedAt || data.finishedAt > data.endedAt) return null;
	}

	if (!Array.isArray(data.steps)) return null;
	const steps: WidgetStep[] = [];
	for (const entry of data.steps) {
		if (typeof entry !== 'object' || entry === null) return null;
		const { id, label, status, startedAt, endedAt } = entry as Record<string, unknown>;
		if (typeof id !== 'string' || typeof label !== 'string') return null;
		if (!STEP_STATUSES.includes(status as WidgetStepStatus)) return null;
		// Timings are additive: absent is fine on anything written before they existed,
		// but present-and-malformed still rejects the whole snapshot.
		if (startedAt !== undefined && !isFiniteNumber(startedAt)) return null;
		if (endedAt !== undefined && !isFiniteNumber(endedAt)) return null;
		steps.push({
			id,
			label,
			status: status as WidgetStepStatus,
			...(isFiniteNumber(startedAt) ? { startedAt } : {}),
			...(isFiniteNumber(endedAt) ? { endedAt } : {})
		});
	}

	// Also additive — an older snapshot simply has no sources.
	const sources: WidgetSource[] = [];
	if (data.sources !== undefined) {
		if (!Array.isArray(data.sources)) return null;
		for (const entry of data.sources) {
			if (typeof entry !== 'object' || entry === null) return null;
			const { n, title, url } = entry as Record<string, unknown>;
			if (!isFiniteNumber(n) || typeof title !== 'string' || typeof url !== 'string') return null;
			sources.push({ n, title, url });
		}
	}

	if (typeof data.metrics !== 'object' || data.metrics === null || Array.isArray(data.metrics)) {
		return null;
	}
	const metrics: Record<string, WidgetMetric> = {};
	for (const [metricKey, entry] of Object.entries(data.metrics as Record<string, unknown>)) {
		if (typeof entry !== 'object' || entry === null) return null;
		const { label, value } = entry as Record<string, unknown>;
		if (typeof label !== 'string' || !isFiniteNumber(value)) return null;
		metrics[metricKey] = { label, value };
	}

	return {
		status: data.status,
		steps,
		sources,
		metrics,
		startedAt: data.startedAt,
		endedAt: data.endedAt,
		...(isFiniteNumber(data.finishedAt) ? { finishedAt: data.finishedAt } : {}),
		...(typeof data.errorMessage === 'string' ? { errorMessage: data.errorMessage } : {})
	};
};

/** One decimal place, with JS dropping a trailing `.0` for us (`String(5.0) === '5'`). */
const oneDecimal = (value: number) => Math.round(value * 10) / 10;

/**
 * Compact counts in the status-line idiom: `512`, `5.1k`, `1M`.
 *
 * Hand-rolled rather than `Intl.NumberFormat` compact notation, which yields an
 * uppercase `K`. Rounding is applied at each scale before the suffix is chosen, so a
 * value that rounds up out of its unit is promoted: 999_950 reads `1M`, never `1000k`.
 */
export const formatCompactCount = (n: number): string => {
	if (!Number.isFinite(n)) return '0';
	const value = Math.max(0, n);
	if (value < 1000) return String(Math.round(value));

	const thousands = oneDecimal(value / 1000);
	if (thousands < 1000) return `${thousands}k`;
	return `${oneDecimal(value / 1_000_000)}M`;
};

/** Durations in the status-line idiom: `12s`, `2m 21s`, `1h 4m`. */
export const formatElapsed = (ms: number): string => {
	const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

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
 * Never falls back to `finishedAt` — that is the stream's end, and using it while
 * `endedAt` was still propagating displayed a 33s session as 6s. `now` is the correct
 * fallback there, since a session is only unstamped while it is still ending.
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

	if (data.type === 'source') {
		const { n, title, url } = data;
		if (typeof n !== 'number' || !Number.isFinite(n)) return null;
		if (typeof title !== 'string' || typeof url !== 'string') return null;
		return { kind: 'source', messageId, n, title, url };
	}

	return null;
};

/**
 * Pure reducer. Upserts are idempotent, so a duplicated frame leaves state deep-equal,
 * and anything arriving after a terminal status is ignored.
 *
 * `at` is the event's arrival time, passed in rather than read from a clock so the
 * reducer stays pure while still being able to time each step.
 */
export const widgetReducer = (state: WidgetState, event: WidgetEvent, at: number): WidgetState => {
	if (isTerminal(state.status)) return state;

	switch (event.kind) {
		case 'done':
			return { ...state, status: 'complete' };

		case 'error':
			return {
				...state,
				status: 'error',
				errorMessage: event.message,
				// Nothing is in progress under a dead session. A step left spinning here
				// would claim work that has stopped.
				steps: state.steps.map((step) =>
					step.status === 'running' ? { ...step, status: 'error', endedAt: at } : step
				)
			};

		case 'step': {
			const index = state.steps.findIndex((step) => step.id === event.id);
			const existing = index === -1 ? undefined : state.steps[index];

			// A repeated frame must not re-stamp, or the deliberate duplicate in the mock
			// would stretch the step's measured duration.
			if (existing && existing.label === event.label && existing.status === event.status) {
				return state.status === 'streaming' ? state : { ...state, status: 'streaming' };
			}

			const wasRunning = existing?.status === 'running';
			const isRunning = event.status === 'running';
			const next: WidgetStep = {
				...existing,
				id: event.id,
				label: event.label,
				status: event.status
			};
			if (isRunning && !wasRunning) {
				next.startedAt = at;
				delete next.endedAt;
			} else if (wasRunning && !isRunning) {
				next.endedAt = at;
			}

			if (index !== -1) {
				const steps = state.steps.slice();
				steps[index] = next;
				return { ...state, status: 'streaming', steps };
			}
			return { ...state, status: 'streaming', steps: [...state.steps, next] };
		}

		case 'source': {
			const index = state.sources.findIndex((source) => source.n === event.n);
			const next: WidgetSource = { n: event.n, title: event.title, url: event.url };
			if (index !== -1) {
				const existing = state.sources[index];
				if (existing.title === next.title && existing.url === next.url) {
					return state.status === 'streaming' ? state : { ...state, status: 'streaming' };
				}
				const sources = state.sources.slice();
				sources[index] = next;
				return { ...state, status: 'streaming', sources };
			}
			return { ...state, status: 'streaming', sources: [...state.sources, next] };
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
