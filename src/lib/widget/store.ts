import { writable } from 'svelte/store';

import { WEBUI_API_BASE_URL } from '$lib/constants';
import {
	getSSEEventReader,
	initialWidgetState,
	isTerminal,
	parseWidgetEvent,
	widgetKey,
	widgetReducer,
	type WidgetState,
	type WidgetStatus
} from './events';

/** Live widget state, keyed `chatId:messageId` so sibling responses never collide. */
export const widgetStates = writable<Record<string, WidgetState>>({});

/** Socket.IO-fed room info, keyed by chatId. Written by Chat.svelte. */
export const chatSessionInfo = writable<
	Record<string, { activeViewers?: number; status?: string }>
>({});

type RunOptions = {
	/** Drop any existing state for this key first (continue-response restart). */
	reset?: boolean;
	scenario?: 'happy' | 'error';
};

/**
 * Streams one widget session. The caller owns the AbortController: destroying the
 * component aborts the request, and every store write is gated on `signal.aborted`
 * so a late frame can never resurrect a widget that is on its way out.
 */
export const runWidgetStream = async (
	chatId: string,
	messageId: string,
	token: string,
	signal: AbortSignal,
	opts: RunOptions = {}
): Promise<void> => {
	const key = widgetKey(chatId, messageId);

	const write = (update: (state: WidgetState) => WidgetState) => {
		if (signal.aborted) return;
		widgetStates.update((states) => {
			const current = states[key];
			if (!current) return states;
			const next = update(current);
			if (next === current) return states;
			const stamped =
				isTerminal(next.status) && next.finishedAt === undefined
					? { ...next, finishedAt: Date.now() }
					: next;
			return { ...states, [key]: stamped };
		});
	};

	if (signal.aborted) return;
	widgetStates.update((states) => {
		if (!opts.reset && states[key]) return states;
		return { ...states, [key]: initialWidgetState(Date.now()) };
	});

	const params = new URLSearchParams({
		chat_id: chatId,
		message_id: messageId,
		scenario: opts.scenario ?? 'happy'
	});

	let reader: ReadableStreamDefaultReader<{ event?: string; data: string }> | null = null;
	try {
		const response = await fetch(`${WEBUI_API_BASE_URL}/widget/events?${params}`, {
			method: 'GET',
			signal,
			headers: {
				Accept: 'text/event-stream',
				Authorization: `Bearer ${token}`
			}
		});

		// Either failing is a genuine failure, not an abort — surface it as `error`.
		if (!response.ok || !response.body) {
			throw new Error(`widget stream failed: ${response.status}`);
		}

		reader = getSSEEventReader(response.body);

		for (;;) {
			if (signal.aborted) break;
			const { value, done } = await reader.read();
			if (done || signal.aborted) break;
			if (!value) continue;

			const event = parseWidgetEvent(value.event, value.data);
			if (!event || event.messageId !== messageId) continue;

			write((state) => widgetReducer(state, event));
		}
	} catch (error) {
		// Aborts are the normal teardown path, not a failure to report.
		if (signal.aborted || (error as Error)?.name === 'AbortError') return;
		write((state) =>
			isTerminal(state.status)
				? state
				: { ...state, status: 'error', errorMessage: (error as Error)?.message }
		);
	} finally {
		reader?.cancel().catch(() => {});
	}
};

/**
 * Records that the generation ended — what elapsed measures, and much later than the
 * stream's own `finishedAt`. Write-once, so a level-triggered caller can re-run it
 * freely. An existing terminal status wins: an errored stream is never rewritten as
 * complete.
 */
export const finalizeWidget = (
	chatId: string,
	messageId: string,
	status: Extract<WidgetStatus, 'complete' | 'error'>
) => {
	const key = widgetKey(chatId, messageId);
	widgetStates.update((states) => {
		const current = states[key];
		if (!current || current.endedAt !== undefined) return states;
		return {
			...states,
			[key]: {
				...current,
				status: isTerminal(current.status) ? current.status : status,
				endedAt: Date.now()
			}
		};
	});
};

/**
 * Puts a validated snapshot back into the store on reload, without disturbing a session
 * that is already there — live state and a fresh restart both outrank stored history.
 */
export const seedWidgetState = (chatId: string, messageId: string, state: WidgetState) => {
	const key = widgetKey(chatId, messageId);
	widgetStates.update((states) => (states[key] ? states : { ...states, [key]: state }));
};

/** Drops in-flight state on destroy; finished snapshots survive for navigate-back. */
export const clearWidgetIfActive = (chatId: string, messageId: string) => {
	const key = widgetKey(chatId, messageId);
	widgetStates.update((states) => {
		const current = states[key];
		if (!current || isTerminal(current.status)) return states;
		const next = { ...states };
		delete next[key];
		return next;
	});
};
