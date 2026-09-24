import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// A finished journey's recordings, one per browser tab it opened, played with the browser's own controls.
export default function JourneyRecording({ urls, name = 'Journey', variant = 'full', className = '' }) {
  const [selected, setSelected] = useState('0');
  const tab = urls[Number(selected)] ? selected : '0', src = urls[Number(tab)];
  return <div role="group" aria-label={`${name} browser`} className={`journey-browser relative flex min-w-0 items-center justify-center overflow-hidden bg-background ${variant === 'focus' ? 'h-full w-full' : 'aspect-video border-y'} ${className}`}>
    <video key={src} src={src} controls preload="metadata" playsInline className="h-full w-full object-contain" aria-label={`${name} recording`} />
    {urls.length > 1 && <Tabs value={tab} onValueChange={setSelected} className="absolute top-2 left-2">
      <TabsList aria-label={`${name} recordings`}>{urls.map((url, index) => <TabsTrigger key={url} value={String(index)} className="text-xs">Tab {index + 1}</TabsTrigger>)}</TabsList>
    </Tabs>}
  </div>;
}
