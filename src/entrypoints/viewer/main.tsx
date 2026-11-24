import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import '../../ui/styles/tokens.css';
import '../../ui/styles/markdown.css';
import '../../ui/styles/app.css';
import { ViewerApp } from '../../ui/ViewerApp';

createRoot(document.getElementById('root')!).render(<ViewerApp />);
