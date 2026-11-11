'use client';

import { useCallback, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
  Sparkles,
  FileUp,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types — mirror the response shape returned by POST /api/ingest.
// ---------------------------------------------------------------------------

interface IngestResult {
  ok: boolean;
  investigationId: string;
  fileName: string;
  format: string;
  pages?: number;
  sheets?: number;
  textLength: number;
  signalsStored: number;
  evidenceStored: number;
  durationMs: number;
  extractedTextPath?: string;
  error?: string;
}

interface DocumentUploadProps {
  /** Called after a successful ingestion so the dashboard can refresh
   *  the investigations list (the new ingest creates a new investigation
   *  row). */
  onIngested?: () => void;
  /** Optional className for the outer Card. */
  className?: string;
}

// Supported file types — must mirror the ALLOWED_EXTENSIONS set in the
// /api/ingest route handler.
const ACCEPT_ATTR =
  '.pdf,.docx,.xlsx,.xls,.pptx,.png,.jpg,.jpeg,.webp,.gif,.txt,.csv,.json,.xml,.log,.tsv,.md,.markdown,.html,.htm';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

const FORMAT_BADGE_CLASS: Record<string, string> = {
  pdf: 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300',
  docx: 'border-sky-300 bg-sky-50 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300',
  xlsx: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  pptx: 'border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950 dark:text-orange-300',
  image: 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300',
  text: 'border-muted bg-muted/40 text-muted-foreground',
  markdown: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300',
  html: 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-300',
  unknown: 'border-muted bg-muted/40 text-muted-foreground',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function DocumentUpload({ onIngested, className }: DocumentUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [topic, setTopic] = useState('');
  const [geography, setGeography] = useState('global');
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // -------------------------------------------------------------------------
  // File selection (drag-and-drop + click-to-browse)
  // -------------------------------------------------------------------------

  const handleFileSelected = useCallback(
    (selected: File | null) => {
      setResult(null);
      setError(null);
      if (!selected) return;
      if (selected.size > MAX_FILE_SIZE_BYTES) {
        setError(
          `File too large: ${formatBytes(selected.size)} (max ${formatBytes(MAX_FILE_SIZE_BYTES)})`,
        );
        return;
      }
      setFile(selected);
      // Auto-fill topic from file name (without extension) when empty.
      if (!topic) {
        const base = selected.name.replace(/\.[^.]+$/, '');
        setTopic(base.slice(0, 80));
      }
    },
    [topic],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      const dropped = e.dataTransfer.files?.[0] ?? null;
      void handleFileSelected(dropped);
    },
    [handleFileSelected],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = e.target.files?.[0] ?? null;
      void handleFileSelected(selected);
    },
    [handleFileSelected],
  );

  // -------------------------------------------------------------------------
  // Upload handler
  // -------------------------------------------------------------------------

  const upload = useCallback(async () => {
    if (!file) {
      setError('Selecciona un archivo primero.');
      return;
    }
    setUploading(true);
    setError(null);
    setResult(null);
    setProgress(5);

    // Fake progress — the actual upload is a single multipart POST; we
    // can't track real byte progress without XHR. Give the user visible
    // movement while waiting for the CLI subprocess to finish.
    const timer = setInterval(() => {
      setProgress((p) => (p < 90 ? p + Math.random() * 4 : p));
    }, 1200);

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('topic', topic.trim() || file.name.replace(/\.[^.]+$/, ''));
      fd.append('geography', geography.trim() || 'global');

      const r = await fetch('/api/ingest', { method: 'POST', body: fd });
      const data: IngestResult = await r.json();
      setProgress(100);
      if (!r.ok) {
        setError(
          (data as any)?.error ??
            (data as any)?.details ??
            `Upload failed (HTTP ${r.status})`,
        );
      } else {
        setResult(data);
        if (data.error) {
          // Partial success — show the result but surface the warning.
          setError(`Partial: ${data.error}`);
        }
        // Refresh the investigations list so the new ingest row appears.
        onIngested?.();
      }
    } catch (e: any) {
      setError(e?.message ?? 'Network error during upload');
    } finally {
      clearInterval(timer);
      setUploading(false);
    }
  }, [file, topic, geography, onIngested]);

  // -------------------------------------------------------------------------
  // Reset
  // -------------------------------------------------------------------------

  const reset = useCallback(() => {
    setFile(null);
    setTopic('');
    setGeography('global');
    setResult(null);
    setError(null);
    setProgress(0);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileUp className="h-4 w-4 text-violet-500" />
          Ingestión de documentos
        </CardTitle>
        <CardDescription className="text-xs">
          Carga un PDF, Word, Excel, PowerPoint, imagen (con OCR), texto,
          markdown o HTML. CHISMOSO extrae el texto y lo convierte en
          señales persistidas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Drop zone */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          aria-label="Drop a file here or click to browse"
          className={`relative cursor-pointer rounded-lg border-2 border-dashed transition-colors p-6 text-center ${
            dragActive
              ? 'border-violet-400 bg-violet-50/50 dark:bg-violet-950/20'
              : 'border-muted-foreground/30 hover:border-violet-400 hover:bg-accent/40'
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={onInputChange}
            className="sr-only"
          />
          {file ? (
            <div className="flex flex-col items-center gap-1.5">
              <FileText className="h-7 w-7 text-violet-500" />
              <div className="text-sm font-medium truncate max-w-full">
                {file.name}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {formatBytes(file.size)} · click para cambiar
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5">
              <Upload className="h-7 w-7 text-muted-foreground" />
              <div className="text-sm font-medium">
                Arrastra un archivo aquí o click para explorar
              </div>
              <div className="text-[10px] text-muted-foreground">
                PDF · Word · Excel · PPT · imagen (OCR) · texto · MD · HTML
              </div>
            </div>
          )}
        </div>

        {/* Topic + geography */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="ingest-topic" className="text-xs">
              Topic
            </Label>
            <Input
              id="ingest-topic"
              placeholder="ej: restaurant automation Colombia"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="text-sm h-8"
              maxLength={200}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ingest-geography" className="text-xs">
              Geografía
            </Label>
            <Input
              id="ingest-geography"
              placeholder="global"
              value={geography}
              onChange={(e) => setGeography(e.target.value)}
              className="text-sm h-8"
              maxLength={100}
            />
          </div>
        </div>

        {/* Upload button */}
        <div className="flex items-center gap-2">
          <Button
            onClick={upload}
            disabled={!file || uploading}
            size="sm"
            className="flex-1"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                Ingestando...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 mr-1.5" />
                Ingerir documento
              </>
            )}
          </Button>
          {(file || result) && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={uploading}>
              Limpiar
            </Button>
          )}
        </div>

        {/* Progress */}
        {uploading && (
          <div className="space-y-1">
            <Progress value={progress} className="h-1.5" />
            <p className="text-[10px] text-muted-foreground">
              Extrayendo texto, normalizando señales y persistiendo evidencia.
              Esto puede tardar hasta 2 min para PDFs grandes o imágenes con OCR.
            </p>
          </div>
        )}

        {/* Error */}
        {error && !uploading && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertTitle className="text-sm">Error</AlertTitle>
            <AlertDescription className="text-xs whitespace-pre-wrap">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {/* Result */}
        {result && (
          <Alert>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <AlertTitle className="text-sm flex items-center gap-2">
              Ingesta completada
              <Badge
                variant="outline"
                className={`text-[10px] ${
                  FORMAT_BADGE_CLASS[result.format] ?? FORMAT_BADGE_CLASS.unknown
                }`}
              >
                {result.format}
              </Badge>
              {result.pages !== undefined && (
                <Badge variant="outline" className="text-[10px]">
                  {result.pages} págs
                </Badge>
              )}
              {result.sheets !== undefined && (
                <Badge variant="outline" className="text-[10px]">
                  {result.sheets} hojas
                </Badge>
              )}
            </AlertTitle>
            <AlertDescription className="text-xs space-y-1.5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                <ResultStat label="Señales" value={result.signalsStored} />
                <ResultStat label="Evidencia" value={result.evidenceStored} />
                <ResultStat
                  label="Texto"
                  value={`${(result.textLength / 1024).toFixed(1)} KB`}
                />
                <ResultStat
                  label="Duración"
                  value={`${(result.durationMs / 1000).toFixed(1)}s`}
                />
              </div>
              <div className="text-[10px] text-muted-foreground font-mono break-all">
                {result.investigationId}
              </div>
              {result.extractedTextPath && (
                <div className="text-[10px] text-muted-foreground">
                  Texto extraído guardado en{' '}
                  <code className="font-mono break-all">
                    {result.extractedTextPath}
                  </code>
                </div>
              )}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function ResultStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded border bg-muted/30 p-1.5">
      <div className="text-[9px] uppercase text-muted-foreground">{label}</div>
      <div className="text-sm font-mono tabular-nums">{value}</div>
    </div>
  );
}
