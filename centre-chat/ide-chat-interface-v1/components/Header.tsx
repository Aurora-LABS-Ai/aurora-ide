import React from 'react';

interface HeaderProps {
  toggleDarkMode: () => void;
  isDark: boolean;
}

const Header: React.FC<HeaderProps> = ({ toggleDarkMode, isDark }) => {
  return (
    <header className="h-12 border-b border-gray-200 dark:border-white/5 flex items-center px-4 justify-between bg-white dark:bg-background-dark/50 backdrop-blur z-20 shrink-0 sticky top-0">
      <div className="flex items-center gap-3">
        <span className="material-icons-round text-gray-400 dark:text-gray-500 text-lg">chat_bubble_outline</span>
        <h1 className="text-sm font-medium text-gray-700 dark:text-gray-200 tracking-tight">IDE Chat Interface V1</h1>
      </div>
      <div className="flex items-center gap-3 text-gray-400 dark:text-gray-500">
        <button className="hover:text-primary transition-colors p-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5">
          <span className="material-icons-round text-lg">history</span>
        </button>
        <button className="hover:text-primary transition-colors p-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5">
          <span className="material-icons-round text-lg">add</span>
        </button>
        <button 
          onClick={toggleDarkMode}
          className="hover:text-primary transition-colors ml-2 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-white/5"
        >
          <span className="material-icons-round text-lg">
            {isDark ? 'light_mode' : 'dark_mode'}
          </span>
        </button>
      </div>
    </header>
  );
};

export default Header;