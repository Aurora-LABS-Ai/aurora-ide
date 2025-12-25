import { useEffect } from 'react';
import { MainLayout } from './components/layout/MainLayout';
import { useUiStore } from './store/useUiStore';

function App() {
  const { theme } = useUiStore();

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  // Disable default context menu globally
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      // Allow context menu in input/textarea elements
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }
      e.preventDefault();
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, []);

  return (
    <MainLayout />
  );
}

export default App;
