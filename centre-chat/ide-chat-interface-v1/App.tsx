import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header';
import ChatMessage from './components/ChatMessage';
import InputArea from './components/InputArea';
import { INITIAL_MESSAGES } from './data';
import { Message, ToolAction } from './types';

const App: React.FC = () => {
  const [isDark, setIsDark] = useState(true);
  const [messages, setMessages] = useState<Message[]>(INITIAL_MESSAGES);
  const [isThinking, setIsThinking] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Initialize dark mode class on body
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDark]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isThinking]);

  const toggleDarkMode = () => {
    setIsDark(!isDark);
  };

  const handleSendMessage = (text: string) => {
    const newUserMsg: Message = {
      id: `user_${Date.now()}`,
      sender: 'user',
      senderName: 'User',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      content: [{ type: 'text', content: text }]
    };

    setMessages(prev => [...prev, newUserMsg]);
    setIsThinking(true);

    // Mock Response Logic
    setTimeout(() => {
      // 1. Initial Agent Response
      const toolId = `tool_${Date.now()}`;
      const newAgentMsg: Message = {
        id: `agent_${Date.now()}`,
        sender: 'agent',
        senderName: 'AURORA',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        content: [
          { type: 'text', content: `I'll handle that for you. Initiating process based on your request: "${text}"` },
          { 
            type: 'tools', 
            actions: [{
              id: toolId,
              toolName: 'analyze_request',
              args: '--deep --verbose',
              icon: 'analytics',
              status: 'pending',
              result: 'Analyzing...'
            }]
          }
        ]
      };
      
      setMessages(prev => [...prev, newAgentMsg]);

      // 2. Simulate Tool Completion after delay
      setTimeout(() => {
        setMessages(prev => prev.map(msg => {
          if (msg.id === newAgentMsg.id) {
            return {
              ...msg,
              content: msg.content.map(c => {
                if (c.type === 'tools') {
                  return {
                    ...c,
                    actions: c.actions.map(a => a.id === toolId ? {
                      ...a,
                      status: 'success' as const, // Explicitly cast to literal type
                      result: "{\n  \"status\": \"complete\",\n  \"confidence\": 0.98,\n  \"latency\": \"124ms\",\n  \"message\": \"Task successfully queued for execution.\"\n}"
                    } : a)
                  };
                }
                return c;
              })
            };
          }
          return msg;
        }));
        setIsThinking(false);
      }, 1500);

    }, 1000);
  };

  return (
    <div className="flex flex-col h-full bg-background-light dark:bg-background-dark transition-colors duration-300">
      <Header toggleDarkMode={toggleDarkMode} isDark={isDark} />
      
      <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:px-64 scroll-smooth relative">
        <div className="max-w-4xl mx-auto min-h-full pb-48">
          {messages.map((msg) => (
            <ChatMessage key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </main>

      <InputArea onSendMessage={handleSendMessage} isThinking={isThinking} />
    </div>
  );
};

export default App;