import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, TooltipProvider } from '@helix/ui';
import '@helix/ui/styles.css';
import { App } from './app/App';
import { Showcase } from './design-system/Showcase';

function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return hash === '#design-system' ? <Showcase /> : <App />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <Root />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
