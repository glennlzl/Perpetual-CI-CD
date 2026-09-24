import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Mic, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { newTestDrafts } from '@/lib/case-drafts';
import { useReturnFocus } from '@/lib/journey-focus';
import { useDescriptionVoice } from '@/lib/use-description-voice';

const MAX_DESCRIPTION = 12000;
const MODEL_REQUIRED = 'Add your OpenRouter API Key in Settings.';
const timeLabel = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function NewTestDialog({ draftKey, onCreate, onTranscribe, onClose, onAppSettings, focusFallback, modelChecked = true, modelConfigured, voiceConfigured }) {
  const [description, setDescription] = useState(() => newTestDrafts.get(draftKey) || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const returnFocus = useReturnFocus(focusFallback);
  const voice = useDescriptionVoice({
    onTranscribe,
    onTranscript: text => {
      setDescription(previous => previous.trimEnd() ? `${previous.trimEnd()}\n${text}` : text);
      setError('');
    },
  });
  // Unsent text is kept however the dialog closes; only a generated test or Discard draft clears it.
  useEffect(() => {
    if (description.trim()) newTestDrafts.set(draftKey, description);
    else newTestDrafts.delete(draftKey);
  }, [draftKey, description]);
  const recording = voice.status === 'recording';
  const voiceBusy = voice.status !== 'idle';
  const tooLong = description.length > MAX_DESCRIPTION;
  function close() {
    if (submitting.current) return;
    voice.cancel();
    onClose();
  }
  function discard() {
    if (submitting.current) return;
    voice.cancel();
    newTestDrafts.delete(draftKey);
    onClose();
  }
  async function submit(event) {
    event.preventDefault();
    if (submitting.current || voiceBusy || !modelConfigured) return;
    if (!description.trim()) return setError('Add a description.');
    if (tooLong) return setError('Shorten the description to 12,000 characters.');
    submitting.current = true;
    setSaving(true); setError('');
    try { await onCreate(description.trim()); newTestDrafts.delete(draftKey); }
    catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setSaving(false); }
  }
  // An unknown model state is not missing, so the gate never flashes while capabilities load.
  const modelMissing = modelChecked && !modelConfigured;
  const voiceBlocker = !voice.supported ? voice.unsupportedReason : modelChecked && !voiceConfigured ? MODEL_REQUIRED : '';
  const voiceDisabled = saving || !voiceConfigured || (voiceBusy && !recording);
  const voiceHint = voiceBlocker || (recording ? 'Stop and transcribe' : 'Transcribe with OpenRouter');
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent aria-describedby={undefined} showCloseButton={!saving} className="new-test-dialog sm:max-w-xl" onCloseAutoFocus={returnFocus}>
      <DialogHeader><DialogTitle>New test</DialogTitle></DialogHeader>
      <form className="new-test-form" onSubmit={submit}>
        {modelMissing && <div className="flex flex-wrap items-center gap-2"><p id="new-test-model-required" className="text-sm text-muted-foreground">{MODEL_REQUIRED}</p><Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={() => { close(); onAppSettings?.(); }}>Settings</Button></div>}
        <div className="new-test-composer">
          <Label className="sr-only" htmlFor="new-test-description">Description</Label>
          <Textarea id="new-test-description" autoFocus required placeholder="Describe the test you want to run…" rows={5} maxLength={MAX_DESCRIPTION} className="new-test-description" disabled={saving} value={description} aria-invalid={tooLong || undefined} aria-describedby={modelMissing ? 'new-test-model-required' : undefined} onChange={event => { setDescription(event.target.value); setError(''); }} />
          <div className="new-test-tools">
            {/* A blocked mic stays focusable (aria-disabled), so its Tooltip names the blocker. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant={recording ? 'secondary' : 'ghost'} size="icon-sm" className="text-muted-foreground hover:text-foreground aria-pressed:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground pointer-coarse:min-h-11" aria-label="Dictate description" {...(voiceBlocker ? { 'aria-describedby': 'new-test-voice-blocker' } : {})} aria-pressed={recording} aria-disabled={voiceDisabled || undefined} onClick={() => { if (voiceDisabled) return; setError(''); if (recording) voice.stop(); else void voice.start(); }}>
                  {recording ? <Square className="fill-current" /> : voiceBusy ? <LoaderCircle className="motion-safe:animate-spin" /> : <Mic />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{voiceHint}</TooltipContent>
            </Tooltip>
            {voiceBlocker && <span id="new-test-voice-blocker" className="sr-only">{voiceBlocker}</span>}
            <span role="status" className="text-xs tabular-nums text-muted-foreground">{recording ? `Recording ${timeLabel(voice.elapsedSeconds)}` : ''}</span>
          </div>
        </div>
        {(error || voice.error || tooLong) && <p role="alert" className="break-words text-sm text-destructive">{error || voice.error || 'Shorten the description to 12,000 characters.'}</p>}
        <DialogFooter>{description.trim() && <Button type="button" variant="ghost" disabled={saving} onClick={discard}>Discard draft</Button>}<Button type="button" variant="outline" disabled={saving} onClick={close}>Cancel</Button><Button type="submit" disabled={saving || voiceBusy || !modelConfigured || !description.trim() || tooLong}>{saving && <LoaderCircle className="motion-safe:animate-spin" />}{saving ? 'Generating…' : 'Generate test'}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
