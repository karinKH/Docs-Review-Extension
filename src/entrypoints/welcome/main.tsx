import { createRoot } from 'react-dom/client';
import '../../ui/styles/tokens.css';
import '../../ui/styles/app.css';
import { Home } from '../../ui/Home';

createRoot(document.getElementById('root')!).render(<Home />);
