import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { ErrorToast } from '../components/ErrorToast';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { StatusToast } from '../components/StatusToast';
import { ThemeToggle } from '../components/ThemeToggle';
import {
  createKnowledgeFolder,
  deleteKnowledgeFolder,
  fetchKnowledgeDocuments,
  fetchKnowledgeFolders,
  getKnowledgeErrorKind,
  knowledgeDocumentsQueryKey,
  knowledgeFoldersQueryKey,
  uploadKnowledgeDocument,
  type KnowledgeDocument,
} from '../lib/knowledge';

const SECTION_CLASSES =
  'rounded-2xl border border-outline-variant bg-surface-container p-4 shadow-sm sm:p-5';

const BUTTON_CLASSES =
  'inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-40';

const INPUT_CLASSES =
  'h-10 w-full rounded-lg border border-outline-variant bg-surface px-3 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 focus:border-primary focus:ring-4 focus:ring-primary/15';

function StatusBadge({ status }: { status: KnowledgeDocument['status'] }) {
  const { t } = useTranslation();
  const classes =
    status === 'indexed'
      ? 'bg-tertiary-container text-on-tertiary-container'
      : status === 'processing'
        ? 'bg-primary-container text-on-primary-container'
        : 'bg-error-container text-on-error-container';

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${classes}`}>
      {t(`knowledge.documents.status.${status}`)}
    </span>
  );
}

function DocumentCard({
  document,
  highlightChunkId,
}: {
  document: KnowledgeDocument;
  highlightChunkId: string | null;
}) {
  const { t } = useTranslation();
  const isHighlighted =
    highlightChunkId !== null && document.id.includes(highlightChunkId);

  return (
    <li
      className={`rounded-xl border bg-surface-container-high p-4 ${
        isHighlighted ? 'border-primary' : 'border-outline-variant'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-on-surface">
            {document.title}
          </h3>
          {document.fileName !== undefined && (
            <p className="mt-0.5 truncate text-[11px] text-on-surface-variant">
              {document.fileName}
            </p>
          )}
        </div>
        <StatusBadge status={document.status} />
      </div>
      {document.snippet !== undefined && document.snippet !== '' && (
        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-on-surface-variant">
          {document.snippet}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-x-3 text-[11px] text-on-surface-variant">
        {document.chunkCount !== undefined && (
          <span>{t('knowledge.documents.chunks', { count: document.chunkCount })}</span>
        )}
        {document.createdAt !== undefined && (
          <span>{t('knowledge.documents.createdAt', { date: document.createdAt.slice(0, 10) })}</span>
        )}
      </div>
    </li>
  );
}

/** Страница управления базой знаний (KB-38.1/KB-38.2). */
export function KnowledgeHubPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const highlightChunkId = searchParams.get('chunkId');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const foldersQuery = useQuery({
    queryKey: knowledgeFoldersQueryKey,
    queryFn: fetchKnowledgeFolders,
  });
  const documentsQuery = useQuery({
    queryKey: knowledgeDocumentsQueryKey(selectedFolderId, search),
    queryFn: () =>
      fetchKnowledgeDocuments({ folderId: selectedFolderId, search }),
  });

  function handleError(cause: unknown): void {
    setError(t(`knowledge.errors.${getKnowledgeErrorKind(cause)}`));
  }

  function invalidateKnowledge(): void {
    void queryClient.invalidateQueries({ queryKey: knowledgeFoldersQueryKey });
    void queryClient.invalidateQueries({
      queryKey: ['knowledge', 'documents'],
    });
  }

  const createFolderMutation = useMutation({
    mutationFn: createKnowledgeFolder,
    onSuccess: () => {
      setNewFolderName('');
      setNotice(t('knowledge.folders.created'));
      invalidateKnowledge();
    },
    onError: handleError,
  });

  const deleteFolderMutation = useMutation({
    mutationFn: deleteKnowledgeFolder,
    onSuccess: (_data, id) => {
      if (selectedFolderId === id) {
        setSelectedFolderId(null);
      }
      setNotice(t('knowledge.folders.deleted'));
      invalidateKnowledge();
    },
    onError: handleError,
  });

  const uploadMutation = useMutation({
    mutationFn: ({
      file,
      folderId,
    }: {
      file: File;
      folderId: string | null;
    }) => uploadKnowledgeDocument(file, folderId),
    onSuccess: () => {
      setSelectedFile(null);
      setNotice(t('knowledge.documents.uploaded'));
      invalidateKnowledge();
    },
    onError: handleError,
  });

  function handleCreateFolder(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (newFolderName.trim() === '') {
      return;
    }
    createFolderMutation.mutate({ name: newFolderName.trim() });
  }

  function handleUpload(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (selectedFile === null) {
      return;
    }
    uploadMutation.mutate({ file: selectedFile, folderId: selectedFolderId });
  }

  const folders = foldersQuery.data?.items ?? [];
  const documents = documentsQuery.data?.items ?? [];
  const isLoading = foldersQuery.isLoading || documentsQuery.isLoading;

  return (
    <div className="flex min-h-svh flex-col bg-surface text-on-surface">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-outline-variant px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Brand compact />
          <Link
            to="/app/chat"
            className="text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t('knowledge.backToChat')}
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {t('knowledge.title')}
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">
          {t('knowledge.subtitle')}
        </p>

        {highlightChunkId !== null && (
          <p
            role="status"
            className="mt-4 rounded-xl border border-primary/30 bg-primary-container px-4 py-3 text-xs text-on-primary-container"
          >
            {t('knowledge.highlightHint', { chunkId: highlightChunkId })}
          </p>
        )}

        <div className="mt-6 grid gap-4 md:grid-cols-[280px_minmax(0,1fr)]">
          <section aria-label={t('knowledge.folders.title')} className={SECTION_CLASSES}>
            <h2 className="text-sm font-semibold">{t('knowledge.folders.title')}</h2>

            <div className="mt-3 space-y-1">
              <button
                type="button"
                onClick={() => setSelectedFolderId(null)}
                aria-pressed={selectedFolderId === null}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  selectedFolderId === null
                    ? 'bg-primary-container font-semibold text-on-primary-container'
                    : 'text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                <span>{t('knowledge.folders.all')}</span>
              </button>
              {folders.map((folder) => (
                <div key={folder.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setSelectedFolderId(folder.id)}
                    aria-pressed={selectedFolderId === folder.id}
                    className={`min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                      selectedFolderId === folder.id
                        ? 'bg-primary-container font-semibold text-on-primary-container'
                        : 'text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {folder.name}
                    {folder.documentCount !== undefined &&
                      ` · ${folder.documentCount}`}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteFolderMutation.mutate(folder.id)}
                    disabled={deleteFolderMutation.isPending}
                    aria-label={t('knowledge.folders.delete', { name: folder.name })}
                    title={t('knowledge.folders.delete', { name: folder.name })}
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-on-surface-variant transition hover:bg-error-container hover:text-on-error-container focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-40"
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      className="size-4"
                    >
                      <path d="M4 6h12M8 6V4h4v2M6 6l.7 10h6.6L14 6" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>

            <form onSubmit={handleCreateFolder} className="mt-4 space-y-2">
              <label htmlFor="knowledge-folder-name" className="sr-only">
                {t('knowledge.folders.nameLabel')}
              </label>
              <input
                id="knowledge-folder-name"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('knowledge.folders.namePlaceholder')}
                className={INPUT_CLASSES}
              />
              <button
                type="submit"
                disabled={
                  newFolderName.trim() === '' || createFolderMutation.isPending
                }
                className={`w-full ${BUTTON_CLASSES}`}
              >
                {t('knowledge.folders.create')}
              </button>
            </form>
          </section>

          <section aria-label={t('knowledge.documents.title')} className={SECTION_CLASSES}>
            <h2 className="text-sm font-semibold">{t('knowledge.documents.title')}</h2>

            <form onSubmit={handleUpload} className="mt-3 flex flex-wrap gap-2">
              <input
                type="file"
                accept=".pdf,.txt,.md,.doc,.docx"
                aria-label={t('knowledge.documents.fileLabel')}
                onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                className="min-w-0 flex-1 text-xs text-on-surface-variant file:mr-2 file:rounded-lg file:border-0 file:bg-surface-container-high file:px-3 file:py-2 file:text-xs file:font-medium file:text-on-surface"
              />
              <button
                type="submit"
                disabled={selectedFile === null || uploadMutation.isPending}
                className={BUTTON_CLASSES}
              >
                {t('knowledge.documents.upload')}
              </button>
            </form>

            <div className="mt-4">
              <label htmlFor="knowledge-search" className="sr-only">
                {t('knowledge.documents.searchLabel')}
              </label>
              <input
                id="knowledge-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('knowledge.documents.searchPlaceholder')}
                className={INPUT_CLASSES}
              />
            </div>

            {isLoading ? (
              <p role="status" className="mt-4 text-sm text-on-surface-variant">
                {t('knowledge.documents.loading')}
              </p>
            ) : documents.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-outline px-4 py-10 text-center text-sm text-on-surface-variant">
                {t('knowledge.documents.empty')}
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {documents.map((document) => (
                  <DocumentCard
                    key={document.id}
                    document={document}
                    highlightChunkId={highlightChunkId}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      {error !== null && (
        <ErrorToast message={error} onClose={() => setError(null)} />
      )}
      {notice !== null && (
        <StatusToast tone="success" message={notice} onClose={() => setNotice(null)} />
      )}
    </div>
  );
}
