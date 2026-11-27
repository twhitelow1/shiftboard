// The Import button on Team, Training → Menu and Stock → Products (managers). The wizard (SmartImport.jsx, with its file readers)
// loads only when it's opened.
import React, { Suspense, lazy, useState } from 'react';
import { Icon } from '../ui.jsx';
import { useT } from '../i18n/index.js';

const SmartImportDialog = lazy(() => import('./SmartImport.jsx'));

export function SmartImportButton({ target, className = 'btn sm' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}><Icon name="upload" />{t(target === 'menu' ? 'smartImport.importMenu' : target === 'products' ? 'smartImport.importProducts' : target === 'availability' ? 'smartImport.importAvailability' : 'smartImport.importTeam')}</button>
      {open && <Suspense fallback={null}><SmartImportDialog target={target} onClose={() => setOpen(false)} /></Suspense>}
    </>
  );
}
