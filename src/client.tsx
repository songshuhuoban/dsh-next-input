import * as React from 'react';
import { SettingsForm, SettingsFormModel, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SettingsFieldSpec, SettingsFieldState, SettingsFormActions, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type { ISessions, SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client';
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { UiSession } from '@deepseek-ai/dsh-client-ui-session/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-connection/client';
import { bindComposerDom } from './composer-dom.js';
import { SuggestionController } from './suggestion-controller.js';
import type { FetchSuggestion, SuggestionContext } from './suggestion-controller.js';
import { CONFIG_NS, DEFAULT_CONFIG, RPC_ENDPOINT } from './protocol.js';
import type { NextInputConfig, SuggestionResponse } from './protocol.js';

const PACKAGE_NAME = 'dsh-next-input';
const LOCALE_NS = 'nextInput';
const dictionaries = {
  zh: {
    title: '下一步输入建议', summary: '在回复结束后生成建议；输入框为空时按 Tab 填入。',
    inherited: '使用当前会话的模型、服务商和凭据，无需填写 API 密钥。',
    enabled: '启用建议', on: '启用', off: '停用',
    retries: '失败重试次数', retriesHint: '首次请求失败后的额外重试次数，默认 3 次。',
    timeout: '每次请求超时（毫秒）', timeoutHint: '超时后进入重试；全部失败时保持默认占位文案。',
    length: '建议最大字数', lengthHint: '保持建议简短，便于直接作为下一条消息。',
    overridden: '已覆盖', reset: '恢复默认', invalid: '请填写允许范围内的整数；留空使用默认值。',
    save: '保存', saving: '保存中…', saveFailed: '设置保存失败，已保留当前修改。',
    readOnly: '当前部署的设置为只读。', unavailable: '插件当前未加载，暂时无法配置。',
  },
  en: {
    title: 'Next input suggestions', summary: 'Suggest a reply when the assistant finishes. Press Tab in an empty composer to fill it.',
    inherited: 'Uses the current session’s model, provider, and credentials. No API key is needed.',
    enabled: 'Enable suggestions', on: 'Enabled', off: 'Disabled',
    retries: 'Retries after failure', retriesHint: 'Additional attempts after the first failure; defaults to 3.',
    timeout: 'Timeout per attempt (milliseconds)', timeoutHint: 'A timeout starts a retry. Exhausted attempts keep the default placeholder.',
    length: 'Maximum suggestion length', lengthHint: 'Keep suggestions short enough to use as the next message.',
    overridden: 'Overridden', reset: 'Reset to default', invalid: 'Enter an integer in the allowed range, or leave blank to use the default.',
    save: 'Save', saving: 'Saving…', saveFailed: 'Settings could not be saved. Your edits have been retained.',
    readOnly: 'Settings are read-only in this deployment.', unavailable: 'This plugin is not loaded, so it cannot be configured.',
  },
};
type LocaleKey = keyof typeof dictionaries.en;
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { nextInput: LocaleKey; }
}

interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** The round id comes from the existing Session window, never a second stream. */
export function completedRound(window: SessionEventWindow): string {
  for (let index = window.entries.length - 1; index >= 0; index--) {
    const entry = window.entries[index];
    if (entry.type !== 'event') continue;
    if (entry.event.type === 'turn/end') return String(entry.event.seq);
    // New work invalidates the preceding round even before running state settles.
    if (entry.event.type === 'turn/start' || entry.event.type === 'user/message') return '';
  }
  return '';
}

const absentRound: Observable<string> = { getSnapshot: () => '', subscribe: () => () => {} };
function roundSource(source: SessionEventSource): Observable<string> {
  return {
    getSnapshot: () => completedRound(source.getSnapshot()),
    subscribe: (listener) => source.subscribe(listener),
  };
}

interface OverlayFace {
  hooks: { round: Observable<string>; config: ConfigForm<NextInputConfig> };
  fetchSuggestion: FetchSuggestion;
  isCurrentRound(roundId: string): boolean;
  hasOptedOut(roundId: string): boolean;
  optOut(roundId?: string): void;
}
type OverlayProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<OverlayFace>;

function SuggestionOverlay(props: OverlayProps) {
  const input = props.useInput((state) => state);
  const session = props.useSession((state) => state);
  const pendingInteraction = props.useSessionStatus((state) => state.get(props.sessionId)?.pendingInteraction);
  const roundId = props.useRound((value) => value);
  const config = props.useConfig((value) => value);
  const settings = config.value ?? DEFAULT_CONFIG;
  const enabled = config.status === 'ready' && settings.enabled;
  const controller = React.useMemo(() => new SuggestionController(props.fetchSuggestion, {
    maxRetries: settings.maxRetries, timeoutMs: settings.timeoutMs,
  }), [props.fetchSuggestion, props.sessionId, settings.maxRetries, settings.timeoutMs, settings.maxSuggestionChars]);
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const marker = React.useRef<HTMLSpanElement>(null);
  const composing = React.useRef(false);
  const draftEmpty = input.draft === '' && input.attachmentIds.length === 0 && input.occurrences.length === 0;
  const idle = !session.running && !session.removed && session.openState === 'open'
    && !session.awaitingFirstTurn && session.pendingSubmissions.length === 0
    && input.phase === 'plain' && input.queue.length === 0 && pendingInteraction === undefined
    && session.subagent?.parentAvailable !== false;
  const live = React.useRef({ input, idle, enabled, roundId, draftEmpty });
  live.current = { input, idle, enabled, roundId, draftEmpty };
  const text = draftEmpty && !props.hasOptedOut(roundId) ? '' : input.draft || '\u0000';
  const context = React.useRef<SuggestionContext>({
    sessionId: props.sessionId, roundId, idle: idle && roundId !== '', enabled,
    text, composing: composing.current,
  });
  context.current = {
    sessionId: props.sessionId, roundId, idle: idle && roundId !== '', enabled,
    text, composing: composing.current,
  };

  React.useLayoutEffect(() => {
    if (!draftEmpty) props.optOut(roundId);
    controller.update(context.current);
  }, [controller, props.sessionId, roundId, idle, enabled, text, draftEmpty]);

  React.useLayoutEffect(() => {
    if (!marker.current) return;
    composing.current = false;
    context.current = { ...context.current, composing: false };
    controller.update(context.current);
    const binding = bindComposerDom(marker.current, {
      canAccept: () => live.current.idle && live.current.enabled && live.current.roundId !== ''
        && live.current.draftEmpty && !composing.current && props.isCurrentRound(live.current.roundId),
      insertSuggestion: (text) => {
        if (controller.getSnapshot().suggestion !== text) return false;
        const span = props.inputActions.captureInsertion();
        if (span.start !== 0 || span.end !== 0 || span.draftRev !== live.current.input.draftRev) return false;
        if (!props.inputActions.insertText(text, span)) return false;
        props.optOut(context.current.roundId);
        controller.accept();
        return true;
      },
      onManualInput: () => {
        // Native input can precede React's render of the latest turn/end.
        props.optOut();
        controller.update({ ...context.current, text: '\u0000' });
      },
      onCompositionChange: (value) => {
        composing.current = value;
        context.current = { ...context.current, composing: value };
        controller.update(context.current);
      },
    });
    const render = () => binding.setSuggestion(controller.getSnapshot().suggestion);
    const unsubscribe = controller.subscribe(render);
    render();
    return () => {
      unsubscribe();
      binding.dispose();
      composing.current = false;
      context.current = { ...context.current, composing: false };
      // StrictMode replays effect teardown/setup on the same component instance.
      // Cancel this attachment without permanently disposing the reusable model.
      controller.update({ ...context.current, enabled: false });
    };
  }, [controller, props.inputActions]);

  // Re-check native placeholder eligibility when input/session guards change.
  // The controller's publication owns text changes and the adapter observes the
  // stock editor's DOM replacement and IME marker.
  React.useLayoutEffect(() => {
    controller.update(context.current);
  }, [controller, snapshot.suggestion, idle, draftEmpty]);
  return <span ref={marker} hidden data-next-input-anchor="" />;
}

interface CardState extends SettingsFormShell {
  enabled: SettingsFieldState;
  maxRetries: SettingsFieldState;
  timeoutMs: SettingsFieldState;
  maxSuggestionChars: SettingsFieldState;
}
interface CardFace extends SettingsFormActions { hooks: { card: Observable<CardState> }; }
type CardProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof LOCALE_NS> & InjectFace<CardFace>;
function SettingsCard(props: CardProps) {
  const state = props.useCard((value) => value);
  const { t } = props;
  if (props.view === 'summary') return t('summary');
  return <SettingsForm state={state} onSave={props.save} onDiscard={props.discard} labels={{
    unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'),
    save: t('save'), saving: t('saving'),
  }}>
    <p style={{ color: 'var(--dsw-alias-label-secondary)', fontSize: 13 }}>{t('inherited')}</p>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <label htmlFor="next-input-enabled">{t('enabled')}</label>
      <select id="next-input-enabled" value={state.enabled.text} disabled={!state.writable || state.saving}
        onChange={(event) => props.edit('enabled', event.target.value)}>
        <option value="true">{t('on')}</option><option value="false">{t('off')}</option>
      </select>
      <button type="button" disabled={!state.writable || state.saving} onClick={() => props.resetField('enabled')}>{t('reset')}</button>
    </div>
    {([
      ['maxRetries', 'retries', 'retriesHint'], ['timeoutMs', 'timeout', 'timeoutHint'],
      ['maxSuggestionChars', 'length', 'lengthHint'],
    ] as const).map(([field, label, hint]) => <SettingsValueField key={field} id={`next-input-${field}`}
      label={t(label)} hint={t(hint)} overriddenLabel={t('overridden')} resetLabel={t('reset')}
      invalidLabel={t('invalid')} numeric disabled={!state.writable || state.saving} {...state[field]}
      onEdit={(text) => props.edit(field, text)} onReset={() => props.resetField(field)} />)}
  </SettingsForm>;
}

function integerField(field: string, minimum: number, maximum: number): SettingsFieldSpec {
  return {
    field, format: (value) => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      if (text.trim() === '') return { kind: 'clear' };
      const value = Number(text);
      return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? { kind: 'set', value } : undefined;
    },
  };
}

export const inject = ['slots', 'locale', 'configForms', 'sessions', 'connection', 'conversation', 'uiSession'];
/** Host and Client have separate Cordis worlds, despite shared declaration names. */
type ClientContext = Pick<Context, 'effect' | 'slots' | 'locale' | 'configForms'> & {
  sessions: ISessions;
  connection: ConnectionHandle;
  conversation: IConversation;
  uiSession: UiSession;
};
export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, dictionaries), 'next-input: dictionaries');
  // A controller may be replaced by a settings edit or a Session remount. Keep
  // the user's decision on this round with the plugin rather than that instance.
  // Each Session owns at most one marker, and deleted catalog entries are pruned.
  const optedOutRounds = new Map<string, string>();
  ctx.effect(() => {
    const unsubscribe = ctx.sessions.list.subscribe(() => {
      const catalog = ctx.sessions.list.getSnapshot();
      if (catalog.phase !== 'ready') return;
      const knownSessions = new Set<string>(catalog.ids);
      for (const sessionId of optedOutRounds.keys()) {
        if (!knownSessions.has(sessionId)) optedOutRounds.delete(sessionId);
      }
    });
    return () => { unsubscribe(); optedOutRounds.clear(); };
  }, 'next-input: round decisions');
  const hasOptedOut = (sessionId: string, roundId: string) => roundId !== '' && optedOutRounds.get(sessionId) === roundId;
  const optOut = (sessionId: string, roundId?: string) => {
    try {
      const binding = ctx.sessions.binding(sessionId as SessionId);
      if (!binding) return;
      const currentRound = completedRound(binding.eventSource.getSnapshot());
      const targetRound = roundId ?? currentRound;
      if (targetRound !== '' && currentRound === targetRound) optedOutRounds.set(sessionId, targetRound);
    } catch {
      // Scope teardown can race the native input handler.
    }
  };
  const form = ctx.configForms.get<NextInputConfig>(CONFIG_NS);
  const forms = new SettingsFormModel(form, [
    {
      field: 'enabled', format: (value) => value === false ? 'false' : 'true',
      parse: (text) => text === '' ? { kind: 'clear' } : text === 'true' || text === 'false'
        ? { kind: 'set', value: text === 'true' } : undefined,
    },
    integerField('maxRetries', 0, 10), integerField('timeoutMs', 1000, 120000),
    integerField('maxSuggestionChars', 16, 1000),
  ]);
  const card = forms.bind((): CardState => ({
    ...forms.shell(), enabled: forms.field('enabled'), maxRetries: forms.field('maxRetries'),
    timeoutMs: forms.field('timeoutMs'), maxSuggestionChars: forms.field('maxSuggestionChars'),
  }));
  ctx.effect(() => () => forms.dispose(), 'next-input: settings form');
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: LOCALE_NS,
    inject: () => ({ hooks: { card }, ...forms.actions() }),
  }, SettingsCard));

  const sources = new WeakMap<SessionEventSource, Observable<string>>();
  const isCurrentRound = (sessionId: string, roundId: string): boolean => {
    try {
      const config = form.getSnapshot();
      if (config.status !== 'ready' || config.value?.enabled !== true || hasOptedOut(sessionId, roundId)) return false;
      const binding = ctx.sessions.binding(sessionId as SessionId);
      if (!binding || roundId === '' || completedRound(binding.eventSource.getSnapshot()) !== roundId) return false;
      const session = binding.session.getSnapshot();
      const input = ctx.conversation.input.for(binding.ctx).state.getSnapshot();
      const status = ctx.uiSession.sessionStatus.getSnapshot().get(binding.sessionId);
      return !session.running && !session.removed && session.openState === 'open'
        && !session.awaitingFirstTurn && session.pendingSubmissions.length === 0
        && session.subagent?.parentAvailable !== false && status?.pendingInteraction === undefined
        && status?.running !== true && input.phase === 'plain' && input.queue.length === 0
        && input.draft === '' && input.attachmentIds.length === 0 && input.occurrences.length === 0;
    } catch {
      // Scope or owner teardown can race native input events and RPC settlement.
      return false;
    }
  };
  const fetchSuggestion: FetchSuggestion = async (request, signal) => {
    if (!isCurrentRound(request.sessionId, request.roundId)) return null;
    const { sessionId, roundId, requestId, requestedAt } = request;
    const result = await ctx.connection.rpc.call('/api', RPC_ENDPOINT, {
      sessionId, roundId, requestId, requestedAt,
    }, signal);
    if (!result.ok) throw new Error('Suggestion unavailable');
    const value = result.value as SuggestionResponse | undefined;
    if (!value || value.sessionId !== request.sessionId || value.roundId !== request.roundId
      || value.requestId !== request.requestId || value.requestedAt !== request.requestedAt
      || !Number.isFinite(value.generatedAt) || value.suggestion !== null && typeof value.suggestion !== 'string') {
      throw new Error('Invalid suggestion response');
    }
    return isCurrentRound(request.sessionId, request.roundId) ? value.suggestion : null;
  };
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: PACKAGE_NAME, order: 100,
    inject: (sessionId) => {
      const eventSource = ctx.sessions.binding(sessionId)?.eventSource;
      let source = absentRound;
      if (eventSource) {
        const cached = sources.get(eventSource);
        source = cached ?? roundSource(eventSource);
        if (!cached) sources.set(eventSource, source);
      }
      return {
        hooks: { round: source, config: form }, fetchSuggestion,
        isCurrentRound: (roundId: string) => isCurrentRound(sessionId, roundId),
        hasOptedOut: (roundId: string) => hasOptedOut(sessionId, roundId),
        optOut: (roundId?: string) => optOut(sessionId, roundId),
      };
    },
  }, SuggestionOverlay));
}
