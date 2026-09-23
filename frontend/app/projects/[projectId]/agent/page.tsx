'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  FileText,
  Image as ImageIcon,
  MessagesSquare,
  Paperclip,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import { useTaskStream } from '@/lib/use-task-stream';
import { AppShell } from '@/components/ui/app-shell';
import { PageLoading, Spinner } from '@/components/ui/spinner';
import { StatusBadge } from '@/components/ui/status-badge';
import { StatusDot } from '@/components/ui/status-dot';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRows, SkeletonText } from '@/components/ui/skeleton';
import { CartenzMark } from '@/components/ui/cartenz-mark';
import { ActivityTimeline } from '@/components/agent/activity-timeline';
import { ChatMarkdown } from '@/components/agent/chat-markdown';
import { PlanView } from '@/components/agent/plan-view';
import { ApprovalPanel } from '@/components/agent/approval-panel';
import { PreviewPanel } from '@/components/projects/preview-panel';
import { TaskInspector } from '@/components/agent/task-inspector';
import { DiffViewer } from '@/components/diff/diff-viewer';
import { isActiveStatus, relativeTime } from '@/lib/format';
import { EnvironmentKindBadge } from '@/components/projects/environment-editor';
import type {
  AgentCapabilities,
  AgentSession,
  ProjectDetail,
  ProjectDocument,
  ProjectEnvironment,
  TaskDetail,
  TaskDiff,
  TaskKind,
  TaskSummary,
} from '@/lib/types';

/**
 * The AI agent workspace: the primary working surface of the platform.
 *
 * Three columns. Left is a quiet list of conversations; centre is the
 * conversation itself and the primary focus — the thread of requests and
 * answers, a pending approval, the composer, then the agent activity stream, the
 * preview, the diff and the plan; right is the selected request's status, its
 * file changes and its test results. Below 1280px the task column moves under
 * the conversation, and on a phone everything stacks with the conversation and
 * composer first and the conversation list last.
 *
 * This is the one deliberately denser, tool-like screen in the portal, so the
 * header is compact: the project name at title size with a back link, rather
 * than a display-size page title, because vertical space here belongs to the
 * conversation.
 *
 * History is per *conversation*, not per request (ADR-046). Submitting a second
 * prompt continues the session you are in rather than opening a new entry in the
 * sidebar, which is how a chat assistant behaves and what a person expects. Each
 * request is still a task underneath — with its own states, tool calls and
 * approval gates — and selecting a turn in the thread is what the right-hand
 * inspector and the activity stream follow.
 */
export default function AgentWorkspacePage() {
  const { loading, user } = useRequireAuth();
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId;

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  /** The requests of the open conversation, oldest first — the thread. */
  const [thread, setThread] = useState<TaskSummary[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(searchParams.get('session'));
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    searchParams.get('task'),
  );
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [diff, setDiff] = useState<TaskDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<TaskKind>('change');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([]);
  const [environmentId, setEnvironmentId] = useState<string>('');
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [attachedIds, setAttachedIds] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  /** Whether the composer's document list is expanded. Presentation only. */
  const [attachOpen, setAttachOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { events, connected } = useTaskStream(selectedTaskId);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  const canDecide = user?.isAdmin ?? false;

  const selectedEnvironment = environments.find((entry) => entry.id === environmentId) ?? null;
  const productionEnvironments = environments.filter((entry) => entry.kind === 'production');
  const openSession = sessions.find((entry) => entry.id === sessionId) ?? null;

  /**
   * Puts a conversation and the request inside it into the address bar, so a
   * reload or a shared link reopens what was being looked at.
   */
  const syncUrl = useCallback(
    (nextSessionId: string | null, nextTaskId: string | null) => {
      const query = new URLSearchParams();
      if (nextSessionId) query.set('session', nextSessionId);
      if (nextTaskId) query.set('task', nextTaskId);
      const suffix = query.toString();
      router.replace(`/projects/${projectId}/agent${suffix ? `?${suffix}` : ''}`);
    },
    [projectId, router],
  );

  const loadProject = useCallback(async () => {
    try {
      const [detail, sessionList, environmentList, documentList] = await Promise.all([
        api.projects.get(projectId),
        api.tasks.sessions(projectId),
        api.projects.environments(projectId),
        api.documents.list(projectId),
      ]);
      setProject(detail);
      setSessions(sessionList);
      setDocuments(documentList);

      // Open the most recent conversation by default, so arriving at the
      // workspace shows where the work was left rather than an empty pane.
      setSessionId((current) => current ?? sessionList[0]?.id ?? null);

      // Production environments are listed but never selectable: the server
      // refuses them, and offering one would only produce a refusal.
      const targetable = environmentList.filter((entry) => entry.kind !== 'production');
      setEnvironments(environmentList);
      setEnvironmentId(
        (current) =>
          current ||
          targetable.find((entry) => entry.isDefaultTarget)?.id ||
          targetable[0]?.id ||
          '',
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The project could not be loaded.');
    }
  }, [projectId]);

  /**
   * Loads the open conversation's requests. A null session is a conversation
   * that does not exist yet — the next prompt opens it — so the thread is empty
   * rather than showing someone else's.
   */
  const loadThread = useCallback(
    async (targetSessionId: string | null) => {
      if (!targetSessionId) {
        setThread([]);
        setSelectedTaskId(null);
        return;
      }
      try {
        const entries = await api.tasks.listForSession(projectId, targetSessionId);
        setThread(entries);
        setSelectedTaskId((current) => {
          // Keep the selection when it is still in this thread; otherwise follow
          // the newest turn, which is the one a person is waiting on.
          if (current && entries.some((entry) => entry.id === current)) return current;
          return entries[entries.length - 1]?.id ?? null;
        });
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : 'The conversation could not be loaded.',
        );
      }
    },
    [projectId],
  );

  useEffect(() => {
    void api.agent
      .capabilities()
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, []);

  const loadTask = useCallback(async (taskId: string) => {
    try {
      setTask(await api.tasks.get(taskId));
    } catch {
      setTask(null);
    }
  }, []);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  useEffect(() => {
    void loadThread(sessionId);
  }, [sessionId, loadThread]);

  useEffect(() => {
    if (selectedTaskId) void loadTask(selectedTaskId);
    else setTask(null);
    // The diff belongs to the previously selected task, so it is cleared rather
    // than shown against a different one.
    setDiff(null);
    setDiffOpen(false);
  }, [selectedTaskId, loadTask]);

  /** Follows the newest turn as it arrives, the way a chat window does. */
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [thread.length]);

  /**
   * The patch is fetched once, when the task reports one exists.
   *
   * Deliberately not part of the task detail: the detail is re-fetched on every
   * realtime event, and a quarter-megabyte patch on each would be wasteful.
   */
  useEffect(() => {
    if (!selectedTaskId || !task?.hasDiff || diff !== null) return;

    let cancelled = false;
    void api.tasks
      .diff(selectedTaskId)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, task?.hasDiff, diff]);

  /**
   * The event stream tells the workspace when to re-read the task. Rather than
   * polling on a timer, the arrival of an event is the trigger, so the panes
   * update as the run progresses and go quiet when it settles. The thread and
   * the session list are refreshed alongside, because a finishing run changes a
   * turn's status and the conversation's last-activity time.
   */
  const latestSequence = events.length > 0 ? events[events.length - 1].sequence : 0;
  useEffect(() => {
    if (!selectedTaskId || latestSequence === 0) return;
    void loadTask(selectedTaskId);
    void loadThread(sessionId);
    void api.tasks.sessions(projectId).then(setSessions).catch(() => undefined);
  }, [latestSequence, selectedTaskId, sessionId, projectId, loadTask, loadThread]);

  const submitPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 10) {
      setError('Describe the change in at least 10 characters.');
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const created = await api.tasks.create(projectId, {
        prompt: prompt.trim(),
        // Continues the open conversation. Null means none is open, and the
        // server opens one — which is the only way a new session is created.
        sessionId: sessionId || undefined,
        environmentId: environmentId || undefined,
        kind,
        documentIds: attachedIds.size > 0 ? [...attachedIds] : undefined,
      });
      setSessionId(created.sessionId);
      setPrompt('');
      setAttachedIds(new Set());
      setSelectedTaskId(created.id);
      syncUrl(created.sessionId, created.id);
      await loadThread(created.sessionId);
      setSessions(await api.tasks.sessions(projectId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The task could not be created.');
    } finally {
      setSubmitting(false);
      promptRef.current?.focus();
    }
  };

  /**
   * Opens a past conversation. The thread is reloaded and the newest turn
   * selected, so the right-hand inspector and the activity stream follow what
   * is being read.
   */
  const openConversation = (nextSessionId: string | null) => {
    setSessionId(nextSessionId);
    setSelectedTaskId(null);
    setTask(null);
    syncUrl(nextSessionId, null);
  };

  const selectTurn = (taskId: string) => {
    setSelectedTaskId(taskId);
    syncUrl(sessionId, taskId);
  };

  const decide = async (decision: 'approved' | 'rejected', note?: string) => {
    if (!selectedTaskId) return;
    try {
      await api.approvals.decide(selectedTaskId, decision, note);
      await loadTask(selectedTaskId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The decision could not be recorded.');
    }
  };

  const cancel = async () => {
    if (!selectedTaskId) return;
    try {
      await api.tasks.cancel(selectedTaskId, 'Cancelled from the agent workspace');
      await loadTask(selectedTaskId);
      await loadThread(sessionId);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The task could not be cancelled.');
    }
  };

  const toggleDocument = (documentId: string) => {
    setAttachedIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * Uploads one file and attaches it. Shared by the file picker and the paste
   * handler so a pasted screenshot and a chosen file take the same path.
   */
  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const uploaded = await api.documents.upload(projectId, file);
      setDocuments((current) => [uploaded, ...current]);
      setAttachedIds((current) => new Set(current).add(uploaded.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The document could not be uploaded.');
    } finally {
      setUploading(false);
    }
  };

  /**
   * Pasting into the prompt uploads and attaches what was pasted. An image is
   * the common case (ADR-042: a screenshot or mock-up the agent can see), and a
   * non-image FILE (a PDF or a document copied from a file manager) takes the
   * same path as the upload button (ADR-030) - so the distinction between
   * "paste" and "upload" disappears. A paste that carries only text is left
   * alone, so ordinary text paste is unaffected.
   */
  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    const fileItem = imageItem ? null : items.find((item) => item.kind === 'file');
    const item = imageItem ?? fileItem;
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    event.preventDefault();
    // Clipboard files often arrive named "image.png" or unnamed; give those a
    // stable, unique name so the attachment list is readable.
    const extension = file.type.split('/')[1] || 'bin';
    const named =
      file.name && file.name !== 'image.png'
        ? file
        : new File([file], `pasted-${Date.now()}.${extension}`, {
            type: file.type,
          });
    await uploadFile(named);
  };

  const removeDocument = async (documentId: string) => {
    try {
      await api.documents.remove(projectId, documentId);
      setDocuments((current) => current.filter((document) => document.id !== documentId));
      setAttachedIds((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The document could not be removed.');
    }
  };

  const active = useMemo(() => (task ? isActiveStatus(task.status) : false), [task]);

  /**
   * Both "new conversation" controls (the list header and the conversation
   * header) take the same path: close the open conversation, clear the draft
   * and return focus to the prompt, so the next request opens a new one.
   */
  const startNewConversation = () => {
    openConversation(null);
    setPrompt('');
    promptRef.current?.focus();
  };

  const attachedDocuments = documents.filter((document) => attachedIds.has(document.id));

  if (loading || !user) return <PageLoading />;
  // The session is known, so the page frame can exist: hold the workspace's
  // shape while the project loads rather than replacing it with a spinner.
  if (!project) return <WorkspaceSkeleton error={error} />;

  return (
    <AppShell>
      <div className="page-wide">
        {/*
          Compact header: the project name at title size rather than display
          size, because this is a working surface and vertical space belongs to
          the conversation. The facts the old project panel carried sit in one
          quiet line beneath it.
        */}
        <header className="mb-8 animate-rise-in">
          <BackLink href={`/projects/${project.id}`} label="Project overview" />
          <p className="eyebrow">Agent workspace</p>
          <h1 className="mt-0.5 truncate text-title text-content">{project.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-content-subtle">
            <span>{project.odooVersion ? `Odoo ${project.odooVersion}` : 'Odoo version not set'}</span>
            <span aria-hidden="true">·</span>
            <span>
              Base branch{' '}
              <span className="font-mono text-caption text-content-muted">{project.defaultBranch}</span>
            </span>
            <span className="hidden sm:inline" aria-hidden="true">
              ·
            </span>
            <span className="hidden sm:inline">
              {project.repositoryUrl ? 'Repository connected' : 'No repository'}
            </span>
          </p>
        </header>

        <div className="grid gap-12 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[248px_minmax(0,1fr)_340px] xl:gap-10">
          {/* LEFT: conversation history. Last on a phone, where the conversation comes first. */}
          <aside
            aria-label="Conversations"
            className="order-last min-w-0 lg:order-none lg:row-span-2 xl:row-span-1"
          >
            <div className="lg:sticky lg:top-6">
              <div className="mb-2 flex items-center justify-between gap-2 pl-3">
                <h2 className="text-callout font-semibold text-content">Conversations</h2>
                <button
                  type="button"
                  onClick={startNewConversation}
                  disabled={submitting}
                  className="icon-btn h-8 w-8"
                  aria-label="New conversation"
                  title="Start a new conversation. The next request opens it."
                >
                  <Plus className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>

              {sessions.length === 0 ? (
                <EmptyState
                  compact
                  icon={MessagesSquare}
                  title="No conversations yet"
                  description="Send a request to start the first one."
                />
              ) : (
                <ul className="-mx-1 max-h-[40vh] space-y-0.5 overflow-y-auto px-1 py-1 lg:max-h-[calc(100vh-13rem)]">
                  {sessions.map((entry) => {
                    const selected = entry.id === sessionId;
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => openConversation(entry.id)}
                          aria-current={selected ? 'true' : undefined}
                          className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
                            selected
                              ? 'bg-surface-raised ring-1 ring-surface-border'
                              : 'hover:bg-surface-overlay/70'
                          }`}
                        >
                          <span
                            className={`line-clamp-2 text-callout ${
                              selected ? 'font-medium text-content' : 'text-content-muted'
                            }`}
                          >
                            {entry.title ?? entry.latestPrompt ?? 'Untitled conversation'}
                          </span>
                          <span className="mt-1 flex items-center justify-between gap-2">
                            <span className="truncate text-meta text-content-subtle">
                              {entry.taskCount} request{entry.taskCount === 1 ? '' : 's'} ·{' '}
                              {relativeTime(entry.lastActivityAt)}
                            </span>
                            {entry.latestStatus ? (
                              <StatusBadge status={entry.latestStatus} className="shrink-0" />
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </aside>

          {/* CENTRE: the conversation, then the run's narration and its review. */}
          <div className="min-w-0 space-y-12">
            <section aria-labelledby="conversation-title" className="space-y-6">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h2 id="conversation-title" className="truncate text-headline text-content">
                    {sessionId ? (openSession?.title ?? 'Current conversation') : 'New conversation'}
                  </h2>
                  {thread.length > 0 ? (
                    <p className="meta mt-0.5">
                      {thread.length} request{thread.length === 1 ? '' : 's'}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={startNewConversation}
                  disabled={submitting || !sessionId}
                  className="btn-ghost btn-sm shrink-0"
                  title={
                    sessionId
                      ? 'Start a new conversation. The next request opens it.'
                      : 'The next request will already start a new conversation'
                  }
                >
                  <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {sessionId ? 'New conversation' : 'New conversation (next request)'}
                  </span>
                  <span className="sm:hidden">New</span>
                </button>
              </div>

              {/*
                The thread. Each turn is the prompt as asked and, for a chat
                task, the answer beneath it. Selecting a turn is what the
                activity stream and the task column follow, so a person can
                scroll back to an earlier request and still see its run.

                The person's turns sit to the right on a raised surface; the
                agent's answers sit to the left as plain prose, so the two are
                told apart by position and surface rather than by colour.
              */}
              {thread.length > 0 ? (
                <div className="-mx-2 max-h-[60vh] space-y-6 overflow-y-auto px-2 py-1">
                  {thread.map((turn) => {
                    const selected = turn.id === selectedTaskId;
                    return (
                      <div key={turn.id} className="space-y-4">
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={() => selectTurn(turn.id)}
                            aria-pressed={selected}
                            className={`block max-w-[90%] rounded-2xl rounded-br-md bg-surface-raised px-4 py-3 text-left transition-colors sm:max-w-[80%] ${
                              selected
                                ? 'ring-2 ring-accent/30'
                                : 'ring-1 ring-surface-border hover:ring-surface-strong'
                            }`}
                          >
                            <span className="block whitespace-pre-wrap break-words text-body text-content">
                              {turn.prompt}
                            </span>
                            <span className="mt-2 flex items-center justify-end gap-3">
                              <span className="mono-meta hidden sm:inline">{turn.reference}</span>
                              <StatusBadge status={turn.status} />
                            </span>
                          </button>
                        </div>

                        {turn.kind === 'chat' && turn.answer ? (
                          <div className="flex max-w-[95%] gap-3 sm:max-w-[88%]">
                            <span
                              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-raised ring-1 ring-surface-border"
                              aria-hidden="true"
                            >
                              <CartenzMark size={14} />
                            </span>
                            <div className="min-w-0 flex-1 pt-0.5">
                              <ChatMarkdown content={turn.answer} />
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                  <div ref={threadEndRef} />
                </div>
              ) : sessionId ? (
                // A conversation is open but its requests have not arrived yet.
                <div className="space-y-4">
                  <Skeleton className="ml-auto h-16 w-3/5 rounded-2xl" />
                  <SkeletonText lines={3} className="max-w-xl" />
                </div>
              ) : (
                <EmptyState
                  compact
                  icon={Sparkles}
                  title="Start a conversation"
                  description="Describe a change to the project, or switch to Chat to ask a question about it."
                />
              )}

              {task?.pendingApproval ? (
                <ApprovalPanel
                  approval={task.pendingApproval}
                  onDecide={decide}
                  canDecide={canDecide}
                />
              ) : null}

              {/*
                The composer: one raised container holding the request, the
                documents attached to it and, in its footer, the quiet options
                (mode, attachments, target) beside the single Send action.
              */}
              <div>
                <form
                  onSubmit={submitPrompt}
                  className="rounded-card border border-surface-border bg-surface-raised transition-colors focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10"
                >
                  <label htmlFor="prompt" className="sr-only">
                    Development request
                  </label>
                  <textarea
                    id="prompt"
                    ref={promptRef}
                    rows={3}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      // Submit on Ctrl/Cmd+Enter: the field is multi-line, so Enter
                      // must insert a newline rather than sending.
                      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                        void submitPrompt(event as unknown as React.FormEvent);
                      }
                    }}
                    onPaste={(event) => void handlePaste(event)}
                    placeholder="Add a customer reference field to Sales Order and Invoice."
                    className="block min-h-[6.5rem] w-full resize-none rounded-t-card bg-transparent px-4 pb-2 pt-4 text-body text-content placeholder:text-content-subtle focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:px-5"
                  />

                  {attachedDocuments.length > 0 ? (
                    <ul className="flex flex-wrap gap-2 px-4 pb-3 sm:px-5" aria-label="Attached documents">
                      {attachedDocuments.map((document) => (
                        <li
                          key={document.id}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-surface-overlay py-1 pl-2.5 pr-1 text-content-muted"
                        >
                          <DocumentIcon mimeType={document.mimeType} />
                          <span className="min-w-0 truncate font-mono text-caption">{document.filename}</span>
                          <button
                            type="button"
                            onClick={() => toggleDocument(document.id)}
                            className="rounded-md p-0.5 text-content-subtle transition-colors hover:bg-surface-raised hover:text-content"
                            aria-label={`Detach ${document.filename}`}
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {attachOpen ? (
                    <div className="animate-rise-in border-t border-surface-border px-4 py-4 sm:px-5">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-callout font-medium text-content">
                          Documents and images{' '}
                          <span className="font-normal text-content-subtle">
                            · {attachedIds.size} selected
                          </span>
                        </p>
                        <label className="btn-ghost btn-sm shrink-0 cursor-pointer">
                          {uploading ? (
                            <Spinner className="h-3.5 w-3.5" />
                          ) : (
                            <Upload className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                          )}
                          {uploading ? 'Uploading…' : 'Upload file'}
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".md,.markdown,.txt,.pdf,.docx,.png,.jpg,.jpeg,.webp,.gif,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp,image/gif"
                            onChange={handleUpload}
                            disabled={uploading}
                            className="hidden"
                          />
                        </label>
                      </div>

                      {documents.length === 0 ? (
                        <p className="text-callout text-content-muted">
                          No documents yet. Upload a PRD and the agent will read it when you send a
                          request.
                        </p>
                      ) : (
                        <ul className="-mx-2 max-h-56 space-y-0.5 overflow-y-auto">
                          {documents.map((document) => (
                            <li
                              key={document.id}
                              className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-overlay/70"
                            >
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                                <input
                                  type="checkbox"
                                  checked={attachedIds.has(document.id)}
                                  onChange={() => toggleDocument(document.id)}
                                />
                                <DocumentIcon mimeType={document.mimeType} />
                                <span className="min-w-0 truncate font-mono text-caption text-content">
                                  {document.filename}
                                </span>
                                {document.mimeType.startsWith('image/') ? (
                                  <span className="hidden shrink-0 text-meta text-content-subtle sm:inline">
                                    Image
                                  </span>
                                ) : null}
                                <span className="shrink-0 text-meta tabular-nums text-content-subtle">
                                  {Math.max(1, Math.round(document.byteSize / 1024))} KB
                                </span>
                              </label>
                              <button
                                type="button"
                                onClick={() => removeDocument(document.id)}
                                className="icon-btn h-7 w-7 shrink-0 hover:text-state-failure"
                                title="Delete document"
                                aria-label={`Delete ${document.filename}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="field-hint mt-3">
                        Markdown, plain text, PDF, DOCX and images (PNG, JPEG, WebP, GIF). Documents up
                        to 10 MiB, images up to 5 MiB. You can also paste a screenshot straight into the
                        request.
                      </p>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2 border-t border-surface-border px-3 py-2.5 sm:px-4">
                    <div
                      role="group"
                      aria-label="Task mode"
                      className="flex rounded-lg bg-surface-overlay p-0.5"
                    >
                      <ModeButton
                        active={kind === 'change'}
                        disabled={submitting}
                        onClick={() => setKind('change')}
                      >
                        Change
                      </ModeButton>
                      <ModeButton
                        active={kind === 'chat'}
                        disabled={submitting}
                        onClick={() => setKind('chat')}
                      >
                        Chat
                      </ModeButton>
                    </div>

                    <button
                      type="button"
                      onClick={() => setAttachOpen((open) => !open)}
                      aria-expanded={attachOpen}
                      className={`btn-ghost btn-sm ${attachOpen ? 'bg-surface-overlay text-content' : ''}`}
                      title="Attach documents or images"
                    >
                      <Paperclip className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                      <span className="hidden sm:inline">Attach</span>
                      {attachedIds.size > 0 ? (
                        <span className="tabular-nums text-content">{attachedIds.size}</span>
                      ) : null}
                    </button>

                    {environments.length > 0 ? (
                      <div className="flex min-w-0 items-center gap-2">
                        <label htmlFor="environment" className="sr-only text-meta text-content-subtle sm:not-sr-only">
                          Target
                        </label>
                        <select
                          id="environment"
                          value={environmentId}
                          onChange={(event) => setEnvironmentId(event.target.value)}
                          disabled={submitting}
                          className="h-8 max-w-[11rem] truncate rounded-lg border border-surface-border bg-surface-raised px-2 text-meta text-content transition-colors hover:border-surface-strong focus:outline-none disabled:opacity-60 sm:max-w-[14rem]"
                        >
                          {environments
                            .filter((environment) => environment.kind !== 'production')
                            .map((environment) => (
                              <option key={environment.id} value={environment.id}>
                                {environment.name} ({environment.branch})
                              </option>
                            ))}
                        </select>
                        {selectedEnvironment ? (
                          <EnvironmentKindBadge kind={selectedEnvironment.kind} />
                        ) : null}
                      </div>
                    ) : null}

                    <div className="ml-auto flex items-center gap-3">
                      <span className="hidden text-caption text-content-subtle md:inline">
                        ⌘ or Ctrl + Enter
                      </span>
                      <button type="submit" disabled={submitting} className="btn-primary btn-sm">
                        {submitting ? (
                          <Spinner className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUp className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                        )}
                        {submitting ? 'Sending' : 'Send'}
                      </button>
                    </div>
                  </div>
                </form>

                <div className="mt-3 space-y-1 px-1 text-meta text-content-subtle">
                  {kind === 'chat' ? (
                    <p>
                      Chat reads the project and answers in plain language. Writing a file asks for
                      your approval first.
                    </p>
                  ) : null}
                  <p>
                    The agent analyses the project, produces a plan and waits for your approval
                    before changing anything.
                    {capabilities && !capabilities.git.pushEnabled
                      ? ' This server cannot push: the branch stays in the workspace for you to review.'
                      : null}
                  </p>
                  {environments.length > 0 && productionEnvironments.length > 0 ? (
                    <p>
                      {productionEnvironments.map((environment) => environment.branch).join(', ')} is
                      production and cannot be targeted.
                    </p>
                  ) : null}
                </div>
              </div>

              {error ? <Alert tone="error">{error}</Alert> : null}
            </section>

            {/* A scrolling log beside other content: the one region here that is boxed. */}
            <section aria-labelledby="activity-title" className="panel overflow-hidden">
              <div className="panel-header">
                <div className="flex min-w-0 items-baseline gap-3">
                  <h2 id="activity-title" className="text-headline text-content">
                    Activity
                  </h2>
                  {task ? (
                    <span className="mono-meta hidden truncate sm:inline">{task.reference}</span>
                  ) : null}
                </div>
                <StatusDot tone={connected ? 'success' : 'idle'} size="small" className="shrink-0">
                  {connected ? 'Live' : 'Offline'}
                </StatusDot>
              </div>
              <div className="max-h-[46vh] overflow-y-auto border-t border-surface-border">
                <ActivityTimeline events={events} />
              </div>
            </section>

            {task?.hasDiff && selectedTaskId ? (
              <PreviewPanel projectId={projectId} taskId={selectedTaskId} hasDiff={task.hasDiff} />
            ) : null}

            {task?.hasDiff ? (
              <section aria-labelledby="diff-title">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 id="diff-title" className="text-headline text-content">
                      Review changes
                    </h2>
                    {task.diffStats ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-content-subtle">
                        <span>
                          {task.diffStats.filesChanged} file
                          {task.diffStats.filesChanged === 1 ? '' : 's'}
                        </span>
                        <span className="font-mono text-caption tabular-nums">
                          <span className="text-state-success">+{task.diffStats.linesAdded}</span>{' '}
                          <span className="text-state-failure">-{task.diffStats.linesRemoved}</span>
                        </span>
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDiffOpen((open) => !open)}
                    aria-expanded={diffOpen}
                    className="btn-secondary btn-sm"
                  >
                    {diffOpen ? 'Hide diff' : 'Show diff'}
                  </button>
                </div>

                {diffOpen ? (
                  <div className="mt-5 animate-fade-in">
                    {diff === null ? (
                      <SkeletonText lines={6} />
                    ) : diff.patch ? (
                      <>
                        <p className="mono-meta mb-3 break-all">
                          {diff.branch} against {diff.baseCommit?.slice(0, 12)}
                        </p>
                        <div className="max-h-[70vh] overflow-y-auto">
                          <DiffViewer
                            patch={diff.patch}
                            truncated={diff.stats?.patchTruncated ?? false}
                          />
                        </div>
                      </>
                    ) : (
                      <p className="py-6 text-center text-callout text-content-subtle">
                        No diff was recorded for this task.
                      </p>
                    )}
                  </div>
                ) : null}
              </section>
            ) : null}

            {task?.plan ? <PlanView plan={task.plan} /> : null}
          </div>

          {/* RIGHT: the selected request's outcome. Under the conversation below 1280px. */}
          <aside aria-labelledby="request-title" className="min-w-0 lg:col-start-2 xl:col-start-auto">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 id="request-title" className="text-headline text-content">
                Request
              </h2>
              {task && active ? (
                <button type="button" onClick={() => void cancel()} className="btn-secondary btn-sm">
                  Cancel task
                </button>
              ) : null}
            </div>
            <TaskInspector task={task} />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}

/** One side of the Change / Chat mode control in the composer footer. */
function ModeButton({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-md px-2.5 py-1 text-meta font-medium transition-colors disabled:cursor-not-allowed ${
        active
          ? 'bg-surface-raised text-content ring-1 ring-surface-border'
          : 'text-content-muted hover:text-content'
      }`}
    >
      {children}
    </button>
  );
}

function DocumentIcon({ mimeType }: { mimeType: string }) {
  const Icon = mimeType.startsWith('image/') ? ImageIcon : FileText;
  return <Icon className="h-4 w-4 shrink-0 text-content-subtle" strokeWidth={1.75} aria-hidden="true" />;
}

/**
 * The workspace's shape while the project loads: header, conversation list,
 * thread and composer as placeholders, so nothing jumps when it arrives. A
 * load failure is shown in place, since the project will not arrive.
 */
function WorkspaceSkeleton({ error }: { error: string | null }) {
  return (
    <AppShell>
      <div className="page-wide">
        <div className="mb-8 space-y-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        {error ? (
          <div className="mb-8">
            <Alert tone="error">{error}</Alert>
          </div>
        ) : null}
        <div className="grid gap-12 lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[248px_minmax(0,1fr)_340px] xl:gap-10">
          <div className="order-last lg:order-none">
            <SkeletonRows rows={5} />
          </div>
          <div className="space-y-6">
            <Skeleton className="ml-auto h-16 w-3/5 rounded-2xl" />
            <SkeletonText lines={4} className="max-w-xl" />
            <Skeleton className="h-40 w-full rounded-card" />
          </div>
          <div className="hidden xl:block">
            <SkeletonText lines={6} />
          </div>
        </div>
      </div>
    </AppShell>
  );
}
