import 'webrtc-adapter';
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installInteractions } from './components/ui/interactions'
import { persistRelayModeFromUrl } from './services/relayPreference'

// Pointer light, magnetic controls, press ripples, card tilt — one set of
// delegated listeners for the whole app. See interactions.ts.
installInteractions();

// `?relay=tls` on whatever link opened the app, before the router can replace
// the URL. See relayPreference.ts.
persistRelayModeFromUrl(window.location.search, () => window.localStorage);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
