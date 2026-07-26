<script lang="ts">
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { socketStatus } from '$lib/stores';
	import {
		isWidgetActive,
		widgetDisplayStatus,
		widgetElapsedMs,
		widgetKey
	} from '$lib/widget/events';
	import {
		chatSessionInfo,
		clearWidgetIfActive,
		finalizeWidget,
		runWidgetStream,
		widgetStates
	} from '$lib/widget/store';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let chatId: string;
	export let messageId: string;
	export let done: boolean = false;
	export let error: unknown = false;
	export let contentLength: number = 0;

	// This component owns the request. One controller, one signal: destroying the
	// component (navigation, chat switch, regenerate) aborts the stream, and nothing
	// else in the app needs to know the stream existed.
	let controller: AbortController | null = null;
	let mounted = false;
	let entered = false;
	let prevDone = done;

	let ticker: ReturnType<typeof setInterval> | null = null;
	let now = Date.now();

	const start = (reset = false) => {
		controller?.abort();
		controller = new AbortController();
		runWidgetStream(chatId, messageId, localStorage.token, controller.signal, { reset });
	};

	const startTicker = () => {
		if (ticker) return;
		now = Date.now();
		// Sampled faster than the second-resolution display it feeds. At 1Hz the tick
		// cadence drifts against startedAt's second boundaries, so two boundaries
		// occasionally fall between ticks and the digits skip (0:05 -> 0:07). Four
		// samples a second observe a boundary within ~250ms and the flip reads smooth.
		// This buys cadence, not guarantees: a blocked main thread or a throttled tab
		// still delays a tick, and the display then jumps to truthful wall time.
		ticker = setInterval(() => (now = Date.now()), 250);
	};

	const stopTicker = () => {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = null;
		// Freeze on the moment the session stopped, not up to a second before it.
		now = Date.now();
	};

	/**
	 * Restarting genuinely needs an edge: continue-response reuses the messageId and
	 * flips `done` back to false, and only that true -> false transition may restart a
	 * stream. Finishing does NOT use an edge — see the level-triggered check below.
	 */
	const syncRestart = (isDone: boolean) => {
		if (prevDone && !isDone) {
			start(true);
		}
		prevDone = isDone;
	};

	onMount(() => {
		mounted = true;
		// Next frame, so the entrance transition has an initial state to animate from.
		requestAnimationFrame(() => (entered = true));

		if (done === false && !$widgetStates[widgetKey(chatId, messageId)]) {
			start();
		}
	});

	onDestroy(() => {
		controller?.abort();
		stopTicker();
		clearWidgetIfActive(chatId, messageId);
	});

	$: key = widgetKey(chatId, messageId);
	$: state = $widgetStates[key];
	$: session = $chatSessionInfo[chatId];

	// Two clocks, deliberately not conflated. `streamStatus` belongs to the scripted
	// side channel, which ends at `widget_done`; the answer frequently generates for
	// far longer. Only the message's own `done` may claim the session is complete —
	// otherwise the widget announces "Complete" with half the answer still arriving.
	$: errored = !!error;
	$: streamStatus = state?.status ?? 'starting';
	$: workflowDone = streamStatus === 'complete';
	$: displayStatus = widgetDisplayStatus(streamStatus, done, errored);
	$: isActive = isWidgetActive(displayStatus);

	// All lifecycle logic waits for mount so SSR and pre-mount updates do nothing.
	$: if (mounted) syncRestart(done);

	// Level-triggered, deliberately not edge-triggered: whenever generation has ended
	// and this session is still unstamped, stamp it. finalizeWidget is write-once, so
	// re-running is harmless — and unlike edge detection, this cannot be defeated by a
	// remount or a coalesced update that hides the moment `done` flipped. Getting that
	// wrong stranded the elapsed timer at the mock's ~6s finish.
	$: if (mounted && state && state.endedAt === undefined && (done || errored)) {
		// Stamp the clock before writing the store. This effect's own store write is not
		// visible to `state` until a later pass, so the elapsed value computed in between
		// must come from `now` — otherwise the timer renders from a state that has no
		// end yet and snaps backwards for as long as nothing else invalidates.
		now = Date.now();
		controller?.abort();
		finalizeWidget(chatId, messageId, errored ? 'error' : 'complete');
	}

	$: if (isActive) startTicker();
	else stopTicker();

	$: elapsedMs = widgetElapsedMs(state, isActive, now);
	$: completedSteps = state?.steps.filter((step) => step.status === 'complete').length ?? 0;
	$: approxTokens = Math.round((contentLength ?? 0) / 4);
	$: activeViewers = session?.activeViewers ?? 1;

	const formatElapsed = (ms: number) => {
		const total = Math.max(0, Math.floor(ms / 1000));
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	};

	const formatMetric = (metricKey: string, value: number) =>
		metricKey === 'confidence'
			? new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(
					value
				)
			: new Intl.NumberFormat().format(value);

	$: statusLabel = {
		starting: $i18n.t('Starting'),
		streaming: $i18n.t('Streaming'),
		complete: $i18n.t('Complete'),
		error: $i18n.t('Error')
	}[displayStatus];

	$: connectionLabel = {
		connected: $i18n.t('Connected'),
		reconnecting: $i18n.t('Reconnecting'),
		offline: $i18n.t('Offline')
	}[$socketStatus];

	$: stepStatusLabel = {
		running: $i18n.t('running'),
		complete: $i18n.t('complete'),
		error: $i18n.t('error')
	};
</script>

<div
	class="live-session-widget {entered ? 'live-session-widget--in' : ''} w-full my-1.5 px-2.5 py-2
		text-xs rounded-lg border border-gray-100 dark:border-gray-850 bg-gray-50/60 dark:bg-gray-900/40"
>
	<!--
		The single live region. Ticking numbers (elapsed, tokens, viewers) stay outside it
		on purpose — inside, a screen reader would announce them every second.
	-->
	<span class="sr-only" role="status" aria-live="polite">{statusLabel}</span>

	<div class="flex items-center gap-2 flex-wrap min-w-0">
		<span
			class="font-medium {displayStatus === 'error'
				? 'text-red-600 dark:text-red-400'
				: 'text-gray-700 dark:text-gray-300'}"
			aria-hidden="true">{statusLabel}</span
		>

		<span class="flex items-center gap-1 text-gray-500 dark:text-gray-400 min-w-0">
			<span
				class="size-1.5 rounded-full shrink-0 {$socketStatus === 'connected'
					? 'bg-green-500'
					: $socketStatus === 'reconnecting'
						? 'bg-amber-500'
						: 'bg-gray-400 dark:bg-gray-600'}"
				aria-hidden="true"
			></span>
			<span class="truncate">{connectionLabel}</span>
		</span>

		<span class="text-gray-500 dark:text-gray-400 tabular-nums">
			{activeViewers === 1
				? $i18n.t('1 session')
				: $i18n.t('{{count}} sessions', { count: activeViewers })}
		</span>

		<!--
			Only shown while a side-channel session is actually open. The backend emits
			'complete' when the scripted stream ends or is cancelled, which says nothing
			about the answer — rendering that as "Session complete" would repeat the very
			claim this widget is careful not to make.
		-->
		{#if session?.status === 'streaming'}
			<span
				class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-850 text-gray-500 dark:text-gray-400"
			>
				{$i18n.t('Session active')}
			</span>
		{/if}
	</div>

	<!--
		Indeterminate by construction: generative work has no known denominator, and a
		step-count fraction would move backwards as new steps arrive. Decorative — the
		adjacent text carries the same information for screen readers.
	-->
	<div
		class="mt-1.5 h-1 w-full rounded-full overflow-hidden bg-gray-200 dark:bg-gray-850"
		aria-hidden="true"
	>
		{#if displayStatus === 'streaming'}
			<div class="rail-segment h-full w-1/3 rounded-full bg-gray-400 dark:bg-gray-600"></div>
		{:else if displayStatus === 'complete'}
			<div class="h-full w-full rounded-full bg-green-500/70"></div>
		{:else if displayStatus === 'error'}
			<div class="h-full w-full rounded-full bg-red-500/70"></div>
		{/if}
	</div>

	{#if displayStatus === 'starting'}
		<div class="mt-1.5 shimmer text-gray-500 dark:text-gray-400">
			{$i18n.t('Preparing session…')}
		</div>
	{:else}
		<div class="mt-1.5 text-gray-500 dark:text-gray-400 tabular-nums">
			{#if displayStatus === 'error'}
				{state?.errorMessage ?? $i18n.t('Stream failed')}
			{:else if workflowDone && !done}
				<!-- The retrieval trace is finished but the answer is not. Say exactly that. -->
				{$i18n.t('Retrieval complete · generating answer…')}
			{:else}
				{$i18n.t('{{count}} steps complete', { count: completedSteps })}
			{/if}
		</div>
	{/if}

	{#if state?.steps?.length}
		<ol class="mt-1.5 flex flex-col gap-0.5">
			{#each state.steps as step (step.id)}
				<li class="flex items-center gap-1.5 min-w-0">
					<span
						class="size-1.5 rounded-full shrink-0 {step.status === 'complete'
							? 'bg-green-500'
							: step.status === 'error'
								? 'bg-red-500'
								: 'bg-gray-400 dark:bg-gray-600'}"
						aria-hidden="true"
					></span>
					<span
						class="truncate {step.status === 'running'
							? 'shimmer'
							: 'text-gray-600 dark:text-gray-400'}"
					>
						{step.label}{step.status === 'running' ? '…' : ''}
					</span>
					<span class="sr-only">{stepStatusLabel[step.status]}</span>
				</li>
			{/each}
		</ol>
	{/if}

	<div class="mt-1.5 flex flex-wrap gap-1">
		{#each Object.entries(state?.metrics ?? {}) as [metricKey, metric] (metricKey)}
			<span
				class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-850 text-gray-600 dark:text-gray-400 tabular-nums"
			>
				{metric.label}
				{formatMetric(metricKey, metric.value)}
			</span>
		{/each}
		<span
			class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-850 text-gray-600 dark:text-gray-400 tabular-nums"
		>
			{$i18n.t('≈ tokens')}
			{approxTokens}
		</span>
		<span
			class="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-850 text-gray-600 dark:text-gray-400 tabular-nums"
		>
			{$i18n.t('Elapsed')}
			{formatElapsed(elapsedMs)}
		</span>
	</div>
</div>

<style>
	/* Interruptible transition rather than an animation, and never from scale(0). */
	.live-session-widget {
		opacity: 0;
		transform: translateY(4px);
		transition:
			opacity 150ms ease-out,
			transform 150ms ease-out;
	}

	.live-session-widget--in {
		opacity: 1;
		transform: translateY(0);
	}

	.rail-segment {
		animation: rail-slide 1.4s ease-in-out infinite;
	}

	@keyframes rail-slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(300%);
		}
	}

	/* Reduced does not mean zero: opacity fades stay, movement and shimmer go. */
	@media (prefers-reduced-motion: reduce) {
		.live-session-widget {
			transform: none;
			transition: opacity 150ms ease-out;
		}

		.live-session-widget--in {
			transform: none;
		}

		.rail-segment {
			animation: none;
			width: 100%;
			opacity: 0.6;
		}

		.live-session-widget :global(.shimmer) {
			animation: none;
		}
	}
</style>
