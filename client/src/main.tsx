import { createRoot } from 'react-dom/client';
import { setNonce } from 'get-nonce';
import App from './App';
import './index.css';
import './pipeline.css';
import './workspace.css';

// Radix dialogs inject scroll-lock CSS; bind it to this response's CSP nonce.
setNonce(document.querySelector<HTMLMetaElement>('meta[name="style-nonce"]')!.content);
createRoot(document.getElementById('root')!).render(<App />);
