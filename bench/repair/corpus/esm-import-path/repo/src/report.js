import { formatBytes } from './utils/bytes.js';

/** A one-line summary of files, each { name, bytes }: how many, and their total size. */
export function summarize(files) {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return `${files.length} ${files.length === 1 ? 'file' : 'files'}, ${formatBytes(total)}`;
}
