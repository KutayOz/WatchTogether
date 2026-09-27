import 'webrtc-adapter';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installInteractions } from './components/ui/interactions'

// Pointer light, magnetic controls, press ripples, card tilt — one set of
// delegated listeners for the whole app. See interactions.ts.
installInteractions();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
