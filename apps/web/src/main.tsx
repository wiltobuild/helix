import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, TooltipProvider } from '@helix/ui';
import '@helix/ui/styles.css';
import { Showcase } from './design-system/Showcase';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <Showcase />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
