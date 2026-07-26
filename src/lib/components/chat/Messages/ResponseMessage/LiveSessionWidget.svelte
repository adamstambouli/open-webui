<script lang="ts">
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import { socketStatus } from '$lib/stores';
	import {
		formatCompactCount,
		formatElapsed,
		isWidgetActive,
		snapshotWidgetState,
		widgetDisplayStatus,
		widgetElapsedMs,
		widgetKey,
		type WidgetSnapshot,
		type WidgetState
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
	/** Persists the finished session onto the message. `(messageId, message) => void`. */
	export let persistSnapshot: ((snapshot: WidgetSnapshot) => Promise<void>) | null = null;

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

	// Persist once per finished session, keyed on its endedAt so continue-response's new
	// session overwrites the old one and nothing else re-saves. `persistedEndedAt` is set
	// only after the save resolves, so a failure retries on the next update instead of
	// being permanently suppressed; `persistingEndedAt` keeps that retry from stacking.
	let persistingEndedAt: number | null = null;
	let persistedEndedAt: number | null = null;

	const persistIfNeeded = async (snapshotState: WidgetState | undefined) => {
		if (!persistSnapshot || !snapshotState?.endedAt) return;
		const { endedAt } = snapshotState;
		if (persistedEndedAt === endedAt || persistingEndedAt === endedAt) return;

		const snapshot = snapshotWidgetState(snapshotState);
		if (!snapshot) return;

		persistingEndedAt = endedAt;
		try {
			await persistSnapshot(snapshot);
			persistedEndedAt = endedAt;
		} catch (e) {
			console.error('Failed to persist live session snapshot', e);
		} finally {
			persistingEndedAt = null;
		}
	};

	$: if (mounted) persistIfNeeded(state);

	$: elapsedMs = widgetElapsedMs(state, isActive, now);
	$: approxTokens = Math.round((contentLength ?? 0) / 4);
	$: activeViewers = session?.activeViewers ?? 1;

	// Confidence is a ratio and reads as a percentage; every other metric is a count.
	const formatMetric = (metricKey: string, value: number) =>
		metricKey === 'confidence'
			? new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(
					value
				)
			: formatCompactCount(value);

	// Expansion is tri-state: `null` means "follow the default", which is expanded while
	// the trace is streaming (the checklist is the point) and collapsed once it settles
	// into a footer. An explicit toggle wins from then on.
	let expandedOverride: boolean | null = null;
	$: expanded = expandedOverride ?? isActive;

	$: metricSummary = Object.entries(state?.metrics ?? {}).map(
		([metricKey, metric]) =>
			`${formatMetric(metricKey, metric.value)} ${metric.label.toLowerCase()}`
	);

	// The last running step is the one being worked on; steps only ever move forward.
	$: runningStep = (state?.steps ?? []).filter((step) => step.status === 'running').at(-1) ?? null;

	/** The one line always on screen: what is happening right now, or how it ended. */
	$: primaryLabel =
		displayStatus === 'error'
			? `${$i18n.t('Error')} · ${state?.errorMessage ?? $i18n.t('Stream failed')}`
			: displayStatus === 'complete'
				? [$i18n.t('Complete'), ...metricSummary].join(' · ')
				: displayStatus === 'starting'
					? $i18n.t('Preparing session…')
					: workflowDone
						? // The trace is done but the answer is not — the two-clock case.
							$i18n.t('Retrieval complete · generating answer…')
						: `${runningStep?.label ?? $i18n.t('Working')}…`;

	$: statsText = `${formatElapsed(elapsedMs)} · ~ ${formatCompactCount(approxTokens)} ${$i18n.t('tokens')}`;
	$: statsSpokenText = $i18n.t('{{duration}}, approximately {{count}} tokens', {
		duration: formatElapsed(elapsedMs),
		count: approxTokens
	});

	/** Healthy states stay silent; only exceptions earn a line in the trace. */
	$: showConnection = $socketStatus !== 'connected';

	$: tooltipText = [
		primaryLabel,
		statsSpokenText,
		...(state?.steps ?? []).map((step) => `${step.label} — ${stepStatusLabel[step.status]}`),
		...(showConnection ? [connectionLabel] : []),
		...(activeViewers > 1 ? [$i18n.t('{{count}} sessions', { count: activeViewers })] : [])
	].join('\n');

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

<div class="live-session-widget {entered ? 'live-session-widget--in' : ''} w-full my-1.5 text-xs">
	<!--
		The single live region. Ticking numbers (elapsed, tokens, viewers) stay outside it
		on purpose — inside, a screen reader would announce them every second.
	-->
	<span class="sr-only" role="status" aria-live="polite">{statusLabel}</span>

	<Tooltip
		content={tooltipText.replace(/\n/g, '<br/>')}
		placement="top"
		touch={false}
		className="w-full"
	>
		<div class="flex items-center gap-1.5 w-full min-w-0">
			<!--
				Shimmer is the working indicator on this line, so it goes on the label itself
				rather than a separate spinner.
			-->
			<span
				class="truncate min-w-0 {displayStatus === 'error'
					? 'text-red-600 dark:text-red-400'
					: isActive
						? 'shimmer'
						: 'text-gray-500 dark:text-gray-400'}"
			>
				{primaryLabel}
			</span>

			<span class="text-gray-400 dark:text-gray-600 tabular-nums shrink-0" aria-hidden="true">
				({statsText})
			</span>
			<span class="sr-only">{statsSpokenText}</span>

			<button
				type="button"
				class="shrink-0 p-0.5 -m-0.5 rounded text-gray-400 dark:text-gray-600 hover:text-gray-600
					dark:hover:text-gray-400 focus-visible:outline-none focus-visible:ring-1
					focus-visible:ring-gray-400 dark:focus-visible:ring-gray-600"
				aria-label={$i18n.t('Toggle session details')}
				aria-expanded={expanded}
				on:click={() => (expandedOverride = !expanded)}
			>
				<ChevronDown className="size-3 transition-transform {expanded ? 'rotate-180' : ''}" />
			</button>
		</div>
	</Tooltip>

	<!--
		Indeterminate by construction: generative work has no known denominator, and a
		step-count fraction would move backwards as new steps arrive. Decorative — the
		line above carries the same information as text. Terminal states drop the rail
		entirely rather than parking a full bar under a settled footer.
	-->
	{#if displayStatus === 'streaming' || displayStatus === 'error'}
		<div
			class="mt-1 h-0.5 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-850"
			aria-hidden="true"
		>
			{#if displayStatus === 'streaming'}
				<div class="rail-segment h-full w-1/3 rounded-full bg-gray-400 dark:bg-gray-600"></div>
			{:else}
				<div class="h-full w-full rounded-full bg-red-500/70"></div>
			{/if}
		</div>
	{/if}

	{#if expanded}
		<div class="mt-1.5 flex flex-col gap-1.5 text-gray-500 dark:text-gray-400">
			{#if state?.steps?.length}
				<ol class="flex flex-col gap-0.5">
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
								class="truncate min-w-0 {step.status === 'running'
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

			{#if metricSummary.length || showConnection || activeViewers > 1 || session?.status === 'streaming'}
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
					{#each metricSummary as entry (entry)}
						<span>{entry}</span>
					{/each}

					<!-- Healthy connections say nothing; only trouble is worth the pixels. -->
					{#if showConnection}
						<span class="flex items-center gap-1 min-w-0">
							<span
								class="size-1.5 rounded-full shrink-0 {$socketStatus === 'reconnecting'
									? 'bg-amber-500'
									: 'bg-gray-400 dark:bg-gray-600'}"
								aria-hidden="true"
							></span>
							<span class="truncate">{connectionLabel}</span>
						</span>
					{/if}

					<!-- One viewer is the norm and not worth reporting. -->
					{#if activeViewers > 1}
						<span>{$i18n.t('{{count}} sessions', { count: activeViewers })}</span>
					{/if}

					<!--
						The backend emits 'complete' when the scripted stream ends or is cancelled,
						which says nothing about the answer — so only the open state is shown.
					-->
					{#if session?.status === 'streaming'}
						<span>{$i18n.t('Session active')}</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
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
