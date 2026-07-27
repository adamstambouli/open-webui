<script lang="ts">
	import { getContext, onDestroy, onMount } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import InfoCircle from '$lib/components/icons/InfoCircle.svelte';
	import ArrowUpRightBox from '$lib/components/icons/ArrowUpRightBox.svelte';
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
		type WidgetState,
		type WidgetStep
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
	/** Persists the finished session onto the message; rejects if the save fails. */
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
		destroyed = true;
		controller?.abort();
		stopTicker();
		clearWidgetIfActive(chatId, messageId);
	});

	$: key = widgetKey(chatId, messageId);
	$: state = $widgetStates[key];
	$: session = $chatSessionInfo[chatId];

	// Two clocks: `streamStatus` is the scripted side channel, `done` is the answer.
	// See widgetDisplayStatus for why only the latter may claim completion.
	$: errored = !!error;
	$: streamStatus = state?.status ?? 'starting';
	$: workflowDone = streamStatus === 'complete';
	$: displayStatus = widgetDisplayStatus(streamStatus, done, errored);
	$: isActive = isWidgetActive(displayStatus);

	// All lifecycle logic waits for mount so SSR and pre-mount updates do nothing.
	$: if (mounted) syncRestart(done);

	// Level-triggered rather than watching for the `done` edge, which a remount or a
	// coalesced update can hide. finalizeWidget is write-once, so re-running is free.
	$: if (mounted && state && state.endedAt === undefined && (done || errored)) {
		// Before the store write, since it is not visible to `state` until a later pass
		// and elapsed must read a fresh clock in the meantime.
		now = Date.now();
		controller?.abort();
		finalizeWidget(chatId, messageId, errored ? 'error' : 'complete');
	}

	$: if (isActive) startTicker();
	else stopTicker();

	// Persist once per finished session, keyed on its endedAt so continue-response's new
	// session overwrites the old one and nothing else re-saves.
	//
	// Retries are explicit rather than implicit. A terminal session produces no further
	// state updates, so this effect will not run again on its own — simply clearing the
	// in-flight guard would leave a failed save looking retryable while nothing ever
	// retried it. Instead the attempts are bounded here, and abandoned on destroy.
	const PERSIST_ATTEMPTS = 3;
	const PERSIST_RETRY_MS = 2000;

	let persistingEndedAt: number | null = null;
	let persistedEndedAt: number | null = null;
	let destroyed = false;

	const persistIfNeeded = async (snapshotState: WidgetState | undefined) => {
		if (!persistSnapshot || snapshotState?.endedAt === undefined) return;
		const { endedAt } = snapshotState;
		if (persistedEndedAt === endedAt || persistingEndedAt === endedAt) return;

		const snapshot = snapshotWidgetState(snapshotState);
		if (!snapshot) return;

		persistingEndedAt = endedAt;
		try {
			for (let attempt = 1; attempt <= PERSIST_ATTEMPTS; attempt++) {
				try {
					await persistSnapshot(snapshot);
					persistedEndedAt = endedAt;
					return;
				} catch (e) {
					if (destroyed || attempt === PERSIST_ATTEMPTS) {
						console.error('Failed to persist live session snapshot', e);
						return;
					}
					await new Promise((resolve) => setTimeout(resolve, PERSIST_RETRY_MS));
					if (destroyed) return;
				}
			}
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

	// Expansion is tri-state: `null` follows the default, which is expanded while the
	// trace is streaming (the checklist is the point) and collapsed once it settles into
	// a footer. An explicit toggle wins only within one session: either direction of the
	// active/terminal transition clears it, so finishing always collapses to the footer
	// and a continue-response always reopens to the checklist. The user can toggle again
	// from there.
	let expandedOverride: boolean | null = null;
	// Not seeded from `isActive`, which is still undefined during setup.
	let prevIsActive = false;

	$: expanded = expandedOverride ?? isActive;
	$: if (isActive !== prevIsActive) {
		expandedOverride = null;
		prevIsActive = isActive;
	}

	$: reconnecting = $socketStatus === 'reconnecting';
	/** Healthy states stay silent on the line; the STATUS section always carries them. */
	$: showConnection = $socketStatus !== 'connected';
	$: isFooter = displayStatus === 'complete';
	$: sources = state?.sources ?? [];
	$: confidence = state?.metrics?.confidence;

	/**
	 * The trace can finish while the answer is still being written. Reporting that final
	 * step as complete would claim finished work that isn't, so it renders as running
	 * until the message itself is done.
	 */
	$: steps = (() => {
		const raw = state?.steps ?? [];
		if (!workflowDone || done || raw.length === 0) return raw;
		return raw.map((step, index) =>
			index === raw.length - 1 ? { ...step, status: 'running' as const, endedAt: undefined } : step
		);
	})();

	$: runningStep = steps.filter((step) => step.status === 'running').at(-1) ?? null;

	/** `—` for a step the session killed: it has no honest duration. */
	const stepDuration = (step: WidgetStep, nowMs: number) => {
		if (step.status === 'error') return '—';
		if (step.startedAt === undefined) return '';
		const ms = (step.endedAt ?? nowMs) - step.startedAt;
		return ms < 10_000 ? `${Math.max(0, ms / 1000).toFixed(1)}s` : formatElapsed(ms);
	};

	/** Priority: error > reconnecting takeover > current step > preparing. */
	$: primaryLabel =
		displayStatus === 'error'
			? `${$i18n.t('Error')} · ${state?.errorMessage ?? $i18n.t('Stream failed')}`
			: reconnecting
				? // You care about the connection, not a stalled label; it returns with the socket.
					$i18n.t('Reconnecting…')
				: displayStatus === 'starting'
					? $i18n.t('Preparing session…')
					: `${runningStep?.label ?? $i18n.t('Working')}…`;

	$: elapsedText = formatElapsed(elapsedMs);
	$: tokensText = `~${formatCompactCount(approxTokens)}`;
	// Spoken as the compact count shown on screen, not the raw integer behind it, and
	// interpolated as `tokens` — i18next reserves `count` for plural selection.
	$: statsSpokenText = $i18n.t('{{duration}}, approximately {{tokens}} tokens received', {
		duration: elapsedText,
		tokens: formatCompactCount(approxTokens)
	});

	$: sessionsText =
		activeViewers === 1
			? $i18n.t('1 session')
			: $i18n.t('{{count}} sessions', { count: activeViewers });

	$: confidenceText = confidence ? formatMetric('confidence', confidence.value) : '';
	$: confidenceHelp = $i18n.t(
		'How strongly the retrieved sources support this answer, based on retrieval scoring. (Mock value in this dev build.)'
	);

	const domainOf = (url: string) => {
		try {
			return new URL(url).hostname;
		} catch {
			return url;
		}
	};

	// The popover is rendered as Svelte markup and handed to tippy by element id, so
	// interpolated source titles are escaped by the framework — no HTML is assembled here.
	$: popoverId = `lsw-popover-${chatId}-${messageId}`.replace(/[^a-zA-Z0-9_-]/g, '-');

	/** Row clicks toggle, except where an inner control owns the interaction. */
	const onRowClick = (event: MouseEvent) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('a, button, .lsw-badge, .lsw-info')) return;
		expandedOverride = !expanded;
	};

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

<div class="lsw {entered ? 'lsw--in' : ''}" class:expanded>
	<!--
		The single live region. Elapsed, tokens and viewer counts stay outside it on
		purpose — inside, a screen reader would announce them every second.
	-->
	<span class="sr-only" role="status" aria-live="polite">{statusLabel}</span>

	<!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
	<div class="lsw-line" on:click={onRowClick}>
		{#if isActive}
			<span class="marker" aria-hidden="true">
				<!-- Taxonomy: spinning = data flowing, blinking amber = attempting, static = settled. -->
				<span class="spinner" class:paused={reconnecting}></span>
			</span>
		{/if}

		{#if isFooter}
			<!--
				Badges are the compact citation reference. Each is its own link with its own
				preview; the cluster exists only as a suppression zone so hovering the gap
				between badges does not flicker the row popover.
			-->
			<span class="lsw-badges">
				{#each sources as source (source.n)}
					<a
						class="lsw-badge"
						href={source.url}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={$i18n.t('Source {{n}}: {{title}}', { n: source.n, title: source.title })}
					>
						{source.n}
						<span class="hover-card">
							<span class="hc-title">{source.title}</span>
							<span class="hc-meta"
								>{domainOf(source.url)}<ArrowUpRightBox
									className="lsw-icon-xs"
									strokeWidth="2"
								/></span
							>
						</span>
					</a>
				{/each}
			</span>
			{#if confidenceText}
				{#if sources.length}<span class="mid" aria-hidden="true">·</span>{/if}
				<span class="lsw-conf">
					<span class="lsw-label">{confidenceText} {$i18n.t('confidence')}</span>
					<button type="button" class="lsw-info" aria-label={confidenceHelp}>
						<InfoCircle className="lsw-icon" strokeWidth="2" />
						<span class="hover-card hc-info" aria-hidden="true">{confidenceHelp}</span>
					</button>
				</span>
			{/if}
		{:else}
			<span class="lsw-label" class:err={displayStatus === 'error'}>{primaryLabel}</span>
		{/if}

		<span class="lsw-tail">
			<Tooltip
				elementId={popoverId}
				placement="top"
				touch={false}
				className="lsw-tail-inner"
				as="span"
			>
				<span class="lsw-stats" aria-hidden="true">
					<span>{elapsedText}</span>
					<span class="stat-sep"></span>
					<span>{tokensText} {$i18n.t('tokens')}</span>
				</span>
				<span class="sr-only">{statsSpokenText}</span>

				<button
					type="button"
					class="lsw-chevron-btn"
					aria-label={$i18n.t('Toggle session details')}
					aria-expanded={expanded}
					on:click={() => (expandedOverride = !expanded)}
				>
					<ChevronDown className="lsw-chevron" strokeWidth="2.5" />
				</button>

				<!--
					Handed to tippy as a DOM element rather than an HTML string, so Svelte
					escapes the source titles for us. Only rendered while collapsed: expanded,
					nothing is hidden, so the popover has nothing to reveal.
				-->
				<span slot="tooltip" id={popoverId}>
					{#if !expanded}
						<span class="pop">
							{#if steps.length}
								<span class="pop-sec">
									<span class="pop-h">{$i18n.t('Steps')} ({steps.length})</span>
									{#each steps as step (step.id)}
										<span class="pop-row">
											<span class="pop-row-label">{step.label}</span>
											<b>{stepDuration(step, now)}</b>
										</span>
									{/each}
								</span>
							{/if}

							{#if sources.length}
								<span class="pop-sec">
									<span class="pop-h pop-h-row">
										<span>{$i18n.t('Sources')} ({sources.length})</span>
										{#if confidenceText}
											<span class="pop-h-side">{confidenceText} {$i18n.t('confidence')}</span>
										{/if}
									</span>
									{#each sources as source (source.n)}
										<span class="pop-row">
											<span class="pop-src">
												<span class="lsw-badge lsw-badge--static">{source.n}</span>
												<span class="pop-src-title">{source.title}</span>
											</span>
										</span>
									{/each}
								</span>
							{/if}

							<span class="pop-sec">
								<span class="pop-h">{$i18n.t('Status')}</span>
								<span class="pop-row">
									<span class="pop-conn">
										<span class="dot" class:warn={showConnection} class:ok={!showConnection}></span>
										{connectionLabel}
									</span>
									<b>{sessionsText}</b>
								</span>
							</span>
						</span>
					{/if}
				</span>
			</Tooltip>
		</span>
	</div>

	<div class="lsw-details">
		<div class="lsw-details-inner">
			{#if steps.length}
				<div class="lsw-sec">
					<div class="lsw-sec-h">{$i18n.t('Steps')} ({steps.length})</div>
					<ol class="lsw-steps">
						{#each steps as step (step.id)}
							<li>
								<span class="marker" aria-hidden="true">
									{#if step.status === 'error'}
										<span class="dot bad"></span>
									{:else if step.status === 'running'}
										<!-- Static amber while reconnecting: the step is not retrying, the socket is. -->
										{#if reconnecting}
											<span class="dot warn"></span>
										{:else}
											<span class="spinner mini"></span>
										{/if}
									{:else}
										<span class="dot ok"></span>
									{/if}
								</span>
								<span class="lsw-step-label"
									>{step.label}{step.status === 'running' ? '…' : ''}</span
								>
								<span class="sr-only">{stepStatusLabel[step.status]}</span>
								<span class="step-dur">{stepDuration(step, now)}</span>
							</li>
						{/each}
					</ol>
				</div>
			{/if}

			{#if sources.length}
				<div class="lsw-sec">
					<div class="lsw-sec-h sec-h-row">
						<span>{$i18n.t('Sources')} ({sources.length})</span>
						{#if confidenceText}
							<span class="lsw-conf sec-h-side">
								<span>{confidenceText} {$i18n.t('confidence')}</span>
								<button type="button" class="lsw-info" aria-label={confidenceHelp}>
									<InfoCircle className="lsw-icon" strokeWidth="2" />
									<span class="hover-card hc-info" aria-hidden="true">{confidenceHelp}</span>
								</button>
							</span>
						{/if}
					</div>
					<ul class="lsw-srcs">
						{#each sources as source (source.n)}
							<li>
								<span class="marker" aria-hidden="true">
									<span class="lsw-badge lsw-badge--static">{source.n}</span>
								</span>
								<a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
								<span class="src-ext" aria-hidden="true"
									><ArrowUpRightBox className="lsw-icon-xs" strokeWidth="2" /></span
								>
								<!-- Anchored to the row, never inside the truncating link: an
									 overflow:hidden ancestor would clip it invisible. -->
								<span class="hover-card src-prev">
									<span class="hc-title">{source.title}</span>
									<span class="hc-meta"
										>{domainOf(source.url)}<ArrowUpRightBox
											className="lsw-icon-xs"
											strokeWidth="2"
										/></span
									>
								</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="lsw-sec">
				<div class="lsw-sec-h">{$i18n.t('Status')}</div>
				<div class="lsw-status-row">
					<span class="conn-row">
						<span class="marker" aria-hidden="true">
							<span
								class="dot"
								class:warn={showConnection}
								class:ok={!showConnection}
								class:blink={reconnecting}
							></span>
						</span>
						{connectionLabel}
					</span>
					<span class="tabnum">{sessionsText}</span>
				</div>
			</div>

			{#if displayStatus === 'error'}
				<div class="lsw-sec">
					<div class="lsw-sec-h">{$i18n.t('Error')}</div>
					<div class="lsw-err">{state?.errorMessage ?? $i18n.t('Stream failed')}</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	/* Tokens mirror the sandbox so light/dark stay in one place. */
	.lsw {
		--sp-text: #6b7280;
		--sp-text-strong: #4b5563;
		--sp-text-faint: #9ca3af;
		--sp-dot: #9ca3af;
		--sp-red: #dc2626;
		--sp-green: #22c55e;
		--sp-amber: #f59e0b;
		--sp-badge-bg: #f3f4f6;
		--sp-badge-text: #6b7280;
		--sp-card-bg: #ffffff;
		--sp-ink: #1c1c1f;
		--sp-hairline: #e4e4e7;

		width: 100%;
		margin: 6px 0;
		font-size: 12px;
		line-height: 1.35;
		opacity: 0;
		transform: translateY(4px);
		transition:
			opacity 150ms ease-out,
			transform 150ms ease-out;
	}

	:global(.dark) .lsw {
		--sp-text: #9ca3af;
		--sp-text-strong: #9ca3af;
		--sp-text-faint: #4b5563;
		--sp-dot: #4b5563;
		--sp-red: #f87171;
		--sp-badge-bg: #262626;
		--sp-badge-text: #9ca3af;
		--sp-card-bg: #1d1d21;
		--sp-ink: #ececef;
		--sp-hairline: #26262b;
	}

	.lsw--in {
		opacity: 1;
		transform: translateY(0);
	}

	/* 3px gap everywhere a marker leads a label: the slot's own centering already pads
	   small dots, so 3px keeps the VISUAL gap consistent with plain dot+text rows. */
	.lsw-line {
		display: flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
		cursor: pointer;
	}

	/* Row hover lifts everything toward foreground — the row is the disclosure control. */
	.lsw-line:hover .lsw-label {
		color: var(--sp-text-strong);
	}
	.lsw-line:hover .lsw-label.err {
		color: var(--sp-red);
	}
	.lsw-line:hover .lsw-stats {
		color: var(--sp-text);
	}
	.lsw-line:hover .lsw-chevron-btn {
		color: var(--sp-text-strong);
	}

	.lsw-label {
		color: var(--sp-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
		transition: color 100ms ease;
	}
	.lsw-label.err {
		color: var(--sp-red);
	}

	.lsw-tail {
		margin-left: auto;
		flex-shrink: 0;
	}
	/* Tooltip renders this element, so it is out of scope for Svelte's CSS scoping. */
	.lsw :global(.lsw-tail-inner) {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.lsw-stats {
		color: var(--sp-text-faint);
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		transition: color 100ms ease;
	}
	.stat-sep {
		width: 12px;
	}
	.tabnum {
		font-variant-numeric: tabular-nums;
	}

	.lsw-chevron-btn {
		appearance: none;
		border: 0;
		background: none;
		padding: 4px;
		margin: -4px;
		flex-shrink: 0;
		color: var(--sp-text-faint);
		cursor: pointer;
		border-radius: 4px;
		display: inline-flex;
		transition: color 100ms ease;
	}
	.lsw-chevron-btn:hover {
		color: var(--sp-text-strong);
	}
	.lsw-chevron-btn:focus-visible {
		outline: 1px solid var(--sp-text-faint);
	}
	.lsw :global(.lsw-chevron) {
		width: 12px;
		height: 12px;
		transition: transform 150ms ease;
	}
	.lsw.expanded :global(.lsw-chevron) {
		transform: rotate(180deg);
	}

	/* Every leading indicator centers in the same fixed slot, so labels across the
	   primary line, steps and sources all align on one axis. */
	.marker {
		width: 15px;
		height: 15px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.spinner {
		flex-shrink: 0;
		width: 11px;
		height: 11px;
		border-radius: 999px;
		border: 1.5px solid var(--sp-text-faint);
		border-top-color: transparent;
		animation: lsw-spin 650ms linear infinite;
	}
	.spinner.mini {
		width: 8px;
		height: 8px;
		border-width: 1.25px;
	}
	/* "Attempting, no response yet" — distinct from spinning (data flowing) and from
	   static (settled). Hard steps, no easing. */
	.spinner.paused {
		border: 0;
		background: var(--sp-amber);
		width: 6px;
		height: 6px;
		animation: lsw-blink 1s steps(1) infinite;
	}
	@keyframes lsw-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@keyframes lsw-blink {
		0%,
		49% {
			opacity: 1;
		}
		50%,
		100% {
			opacity: 0.25;
		}
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		flex-shrink: 0;
		background: var(--sp-dot);
	}
	.dot.ok {
		background: var(--sp-green);
	}
	.dot.warn {
		background: var(--sp-amber);
	}
	.dot.bad {
		background: var(--sp-red);
	}
	/* Blink follows the word: only elements that say "Reconnecting" blink. */
	.dot.blink {
		animation: lsw-blink 1s steps(1) infinite;
	}

	.mid {
		color: var(--sp-text-faint);
		margin: 0 2px;
	}

	/* Expand/collapse via the grid-rows 0fr->1fr trick — no JS measuring. visibility
	   flips after the transition so collapsed content is never tabbable. */
	.lsw-details {
		display: grid;
		grid-template-rows: 0fr;
		opacity: 0;
		visibility: hidden;
		color: var(--sp-text);
		transition:
			grid-template-rows 200ms ease-out,
			opacity 150ms ease-out,
			visibility 0s linear 200ms;
	}
	.lsw.expanded .lsw-details {
		grid-template-rows: 1fr;
		opacity: 1;
		visibility: visible;
		transition:
			grid-template-rows 200ms ease-out,
			opacity 150ms ease-out,
			visibility 0s;
	}
	/* The rail sits under the CENTER of the 15px marker column. Spacing lives OUTSIDE
	   the border so the rule starts at the first section label, not the line above. */
	.lsw-details-inner {
		overflow: hidden;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 8px;
		margin-left: 7px;
		padding-left: 12px;
		border-left: 1px solid var(--sp-hairline);
	}

	/* No horizontal rules: the rail, the mono labels and the gaps already encode
	   section boundaries. Uniform header height keeps label->body rhythm constant. */
	.lsw-sec {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.lsw-sec-h {
		font:
			600 9px/1 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--sp-text-faint);
		min-height: 15px;
		display: flex;
		align-items: center;
	}
	.lsw-sec > :not(.lsw-sec-h) {
		padding-left: 6px;
	}
	.sec-h-row {
		justify-content: space-between;
		gap: 10px;
	}
	.sec-h-side {
		font: 400 11px/1.2 inherit;
		text-transform: none;
		letter-spacing: 0;
		color: var(--sp-text);
	}

	.lsw-steps,
	.lsw-srcs {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.lsw-steps li,
	.lsw-srcs li {
		display: flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
		position: relative;
	}
	.lsw-srcs li {
		cursor: pointer;
	}
	.lsw-step-label {
		color: var(--sp-text-strong);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.step-dur {
		margin-left: auto;
		color: var(--sp-text-faint);
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
		padding-left: 10px;
	}

	.lsw-status-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
	}
	.conn-row {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
	}

	.lsw-err {
		color: var(--sp-red);
	}

	/* Confidence and its icon are one unit — no line-level gap between them. */
	.lsw-conf {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
	}
	.lsw-info {
		appearance: none;
		border: 0;
		background: none;
		padding: 0;
		position: relative;
		display: inline-flex;
		align-items: center;
		color: var(--sp-text-faint);
		cursor: help;
		flex-shrink: 0;
	}
	.lsw-info:hover,
	.lsw-info:focus-visible {
		color: var(--sp-text-strong);
		outline: none;
	}
	.lsw :global(.lsw-icon) {
		width: 12px;
		height: 12px;
	}
	.lsw :global(.lsw-icon-xs) {
		width: 10px;
		height: 10px;
	}

	/* ---------- citation badges ---------- */
	.lsw-badges {
		display: inline-flex;
		gap: 3px;
		align-items: center;
	}
	.lsw-badge {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 15px;
		height: 15px;
		padding: 0 3px;
		border-radius: 4px;
		background: var(--sp-badge-bg);
		color: var(--sp-badge-text);
		font-size: 10px;
		font-weight: 600;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 100ms ease,
			color 100ms ease;
	}
	.lsw-badge--static {
		cursor: default;
	}
	.lsw-badge:hover,
	.lsw-badge:focus-visible {
		color: var(--sp-ink);
		outline: none;
		background: color-mix(in srgb, var(--sp-badge-text) 22%, var(--sp-badge-bg));
	}

	.lsw-srcs a {
		color: var(--sp-text-strong);
		text-decoration: underline;
		text-decoration-color: var(--sp-text-faint);
		text-underline-offset: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Group hover: badge, title and the new-tab hint light together, either way round. */
	.lsw-srcs li:hover a,
	.lsw-srcs li:focus-within a {
		color: var(--sp-ink);
	}
	.lsw-srcs li:hover .lsw-badge,
	.lsw-srcs li:focus-within .lsw-badge {
		color: var(--sp-ink);
		background: color-mix(in srgb, var(--sp-badge-text) 22%, var(--sp-badge-bg));
	}
	.src-ext {
		display: inline-flex;
		color: var(--sp-text-faint);
		opacity: 0;
		transition: opacity 100ms ease;
		flex-shrink: 0;
	}
	.lsw-srcs li:hover .src-ext,
	.lsw-srcs li:focus-within .src-ext {
		opacity: 1;
	}

	/* ---------- hover cards ---------- */
	.hover-card {
		position: absolute;
		bottom: calc(100% + 6px);
		padding: 8px 10px;
		border-radius: 8px;
		border: 1px solid var(--sp-hairline);
		background: var(--sp-card-bg);
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
		font-size: 11px;
		line-height: 1.5;
		font-weight: 400;
		color: var(--sp-text-strong);
		opacity: 0;
		pointer-events: none;
		transition: opacity 120ms ease-out;
		z-index: 10;
		left: 50%;
		transform: translateX(-50%);
		width: 230px;
	}
	.hc-info {
		width: 200px;
	}
	.lsw-badge:hover .hover-card,
	.lsw-badge:focus-visible .hover-card,
	.lsw-info:hover .hover-card,
	.lsw-info:focus-visible .hover-card {
		opacity: 1;
	}
	.src-prev {
		left: 21px;
		transform: none;
		bottom: calc(100% + 4px);
	}
	.lsw-srcs li:hover .src-prev,
	.lsw-srcs li:focus-within .src-prev {
		opacity: 1;
	}
	.hc-title {
		font-weight: 600;
		color: var(--sp-ink);
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hc-meta {
		color: var(--sp-text-faint);
		font-size: 10px;
		display: inline-flex;
		align-items: center;
		gap: 3px;
	}

	/* ---------- popover (tippy content element) ---------- */
	.pop {
		display: grid;
		gap: 2px;
		font-size: 10.5px;
		line-height: 1.35;
		max-width: 280px;
	}
	.pop-sec {
		display: block;
	}
	.pop-sec + .pop-sec {
		border-top: 1px solid var(--sp-hairline);
		margin-top: 5px;
		padding-top: 4px;
	}
	.pop-h {
		font:
			600 9px/1 ui-monospace,
			SFMono-Regular,
			Menlo,
			monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		opacity: 0.7;
		margin: 1px 0 3px;
		display: block;
	}
	.pop-h-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}
	.pop-h-side {
		text-transform: none;
		letter-spacing: 0;
		font-weight: 400;
	}
	.pop-row {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
		min-width: 0;
	}
	.pop-row-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}
	.pop-row b {
		font-weight: 500;
		font-variant-numeric: tabular-nums;
		flex-shrink: 0;
	}
	.pop-src {
		display: inline-flex;
		gap: 5px;
		align-items: flex-start;
		min-width: 0;
	}
	.pop-src-title {
		white-space: normal;
	}
	.pop-conn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	/* Reduced motion: fully static — blinking is motion too. Activity is carried by the
	   "…" on the label and the live region, the same signal screen readers get. */
	@media (prefers-reduced-motion: reduce) {
		.lsw {
			transform: none;
			transition: opacity 150ms ease-out;
		}
		.lsw--in {
			transform: none;
		}
		.spinner {
			border: 0;
			background: var(--sp-text-faint);
			width: 6px;
			height: 6px;
			animation: none;
		}
		/* .spinner.paused outranks .spinner, so its blink must be killed explicitly. */
		.spinner.paused {
			background: var(--sp-amber);
			animation: none;
		}
		.dot.blink {
			animation: none;
		}
		.lsw :global(.lsw-chevron) {
			transition: none;
		}
		.lsw-details,
		.lsw.expanded .lsw-details {
			transition: none;
		}
	}
</style>
