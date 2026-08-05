import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FixtureCard } from './FixtureCard.js';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FixtureCard />
  </StrictMode>,
);
