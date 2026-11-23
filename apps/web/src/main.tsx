import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import App from './App'
import UpdateNotice from './components/UpdateNotice'
import { loadBranding } from './branding'
import LoadBoundary from './components/LoadBoundary'
import { route } from './routes'
import './styles.css'

// The controller page (DJI Pilot 2 on the RC) needs none of the dashboard: it loads on its own.
const PilotLogin = lazy(() => import('./pages/PilotLogin'))

// Branding first, so a customer's installation never flashes another name or colour.
void loadBranding().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {route === 'pilot' ? (
        <LoadBoundary>
          <Suspense fallback={null}>
            <PilotLogin />
          </Suspense>
        </LoadBoundary>
      ) : (
        <>
          <App />
          <UpdateNotice />
        </>
      )}
    </StrictMode>,
  )
})
