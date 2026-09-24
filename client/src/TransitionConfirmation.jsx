import { useRef, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';

export default function TransitionConfirmation({ dialog, pipeline, onAction, onClose, busy }) {
  const transition = pipeline?.transitions?.find(edge =>
    edge.source === dialog.sourceStageId && edge.target === dialog.targetStageId);
  const [paused] = useState(Boolean(transition?.blocked));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const focusOrigin = useRef(null);
  const locked = busy || pending;
  const action = paused ? 'Resume deployment' : 'Pause deployment';
  const source = pipeline?.stages?.find(stage => stage.id === dialog.sourceStageId)?.name;
  const target = pipeline?.stages?.find(stage => stage.id === dialog.targetStageId)?.name;

  async function confirm(event) {
    // Keep the modal open until the change has been saved successfully.
    event.preventDefault();
    if (locked || saving.current || !transition) return;
    saving.current = true;
    setPending(true);
    setError('');
    try {
      await onAction({
        action: 'set-transition', sourceStageId: dialog.sourceStageId,
        targetStageId: dialog.targetStageId, blocked: !paused,
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save. Try again.');
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return <AlertDialog open onOpenChange={open => { if (!open && !locked) onClose(); }}>
    <AlertDialogContent aria-busy={locked}
      onOpenAutoFocus={() => { focusOrigin.current = document.activeElement; }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (focusOrigin.current instanceof HTMLElement && focusOrigin.current.isConnected) {
          focusOrigin.current.focus({ preventScroll: true });
        }
      }}
      onEscapeKeyDown={event => { if (locked) event.preventDefault(); }}>
      <AlertDialogHeader>
        <AlertDialogTitle>{action}?</AlertDialogTitle>
        <AlertDialogDescription>{source} → {target}</AlertDialogDescription>
      </AlertDialogHeader>
      {(error || !transition) && <p role="alert" className="text-sm text-destructive">{error || 'This transition is no longer available.'}</p>}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={locked}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="default" disabled={locked || !transition} onClick={confirm}>
          {pending ? paused ? 'Resuming…' : 'Pausing…' : action}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
