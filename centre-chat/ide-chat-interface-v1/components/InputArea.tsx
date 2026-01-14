import React, { useState, useRef, useEffect } from 'react';

interface InputAreaProps {
  onSendMessage: (text: string) => void;
  isThinking: boolean;
}

const InputArea: React.FC<InputAreaProps> = ({ onSendMessage, isThinking }) => {
  const [inputText, setInputText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = () => {
    if (inputText.trim() && !isThinking) {
      onSendMessage(inputText);
      setInputText('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-[95%] md:w-[85%] lg:w-[60%] z-30">
      <div className="glass-panel rounded-2xl p-3 shadow-2xl bg-white/80 dark:bg-[#1a1a1a]/90 relative overflow-hidden group transition-all duration-300 hover:shadow-neon/20">
        
        {/* Top Glow Line */}
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary/50 to-transparent"></div>
        
        {/* Model Selector & Status */}
        <div className="flex justify-between items-center mb-2">
          <button className="flex items-center gap-2 px-2 py-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            <span className="material-icons-round text-sm text-primary">auto_awesome</span>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">MiniMax-M2.1</span>
            <span className="material-icons-round text-xs text-gray-400">expand_more</span>
          </button>
          
          <div className={`flex items-center gap-2 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 transition-opacity duration-300 ${isThinking ? 'opacity-100' : 'opacity-0'}`}>
            <span className="material-icons-round text-xs text-primary animate-pulse">psychology</span>
            <span className="text-[10px] font-medium text-primary tracking-wide uppercase">Thinking</span>
          </div>
        </div>

        {/* Input Textarea */}
        <textarea 
          ref={textareaRef}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isThinking}
          className="w-full bg-transparent border-0 resize-none focus:ring-0 text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 px-2 py-1 h-16 leading-relaxed focus:outline-none disabled:opacity-50" 
          placeholder="Message Aurora (Type @ to add files)..."
        ></textarea>
        
        {/* Footer Actions */}
        <div className="flex justify-between items-center px-2 pt-2">
          {/* Custom Spinner / Send Button Status */}
          <div className="flex items-center gap-2">
             {isThinking && (
                 <div className="w-4 h-4 rounded-full border-2 border-primary/30 border-t-primary animate-spin-custom"></div>
             )}
          </div>
          
          <div className="flex items-center gap-2">
            <button 
              onClick={handleSend}
              disabled={!inputText.trim() || isThinking}
              className={`w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-200 
                ${inputText.trim() && !isThinking ? 'bg-primary text-white hover:bg-cyan-400 shadow-neon' : 'bg-gray-100 dark:bg-white/10 text-gray-400 cursor-not-allowed'}
              `}
            >
              <span className="material-icons-round text-sm">arrow_upward</span>
            </button>
          </div>
        </div>

        {/* Outer Glow Border Effect */}
        <div className="absolute inset-0 rounded-2xl border border-primary/30 pointer-events-none shadow-[0_0_15px_rgba(6,182,212,0.1)] transition-opacity duration-300 opacity-50 group-hover:opacity-100"></div>
      </div>
      
      {/* Status Text below input */}
      {isThinking && (
        <div className="flex justify-center items-center gap-2 mt-2 text-[10px] text-gray-400 dark:text-gray-600 animate-pulse">
          <span className="material-icons-round text-[10px] text-primary">stream</span>
          <span>Streaming response...</span>
        </div>
      )}
    </div>
  );
};

export default InputArea;