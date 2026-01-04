/**
 * GitBranchSelector Component
 * Dropdown to view and switch branches
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GitBranch, ChevronDown, Check, Plus, Globe } from 'lucide-react';
import { useGitStore } from '../../store/useGitStore';

export const GitBranchSelector: React.FC = () => {
  const { currentBranch, branches, checkout, createBranch, loadBranches } = useGitStore();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsCreating(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Focus input when creating
  useEffect(() => {
    if (isCreating && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isCreating]);

  const handleToggle = useCallback(() => {
    if (!isOpen) {
      loadBranches();
    }
    setIsOpen(!isOpen);
    setIsCreating(false);
  }, [isOpen, loadBranches]);

  const handleCheckout = useCallback(async (branchName: string, isRemote: boolean) => {
    try {
      // For remote branches, extract the branch name without origin/ prefix
      // This will create a local tracking branch or switch to existing one
      let targetBranch = branchName;
      if (isRemote) {
        // Remove remote prefix (e.g., "origin/feature" -> "feature")
        const parts = branchName.split('/');
        if (parts.length > 1) {
          targetBranch = parts.slice(1).join('/');
        }
      }
      await checkout(targetBranch);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to checkout branch:', error);
    }
  }, [checkout]);

  const handleCreateBranch = useCallback(async () => {
    if (!newBranchName.trim()) return;
    try {
      await createBranch(newBranchName.trim());
      setNewBranchName('');
      setIsCreating(false);
      setIsOpen(false);
    } catch (error) {
      console.error('Failed to create branch:', error);
    }
  }, [newBranchName, createBranch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCreateBranch();
    } else if (e.key === 'Escape') {
      setIsCreating(false);
      setNewBranchName('');
    }
  }, [handleCreateBranch]);

  const localBranches = branches.filter(b => !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Branch Button */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
        style={{
          background: 'var(--aurora-editor-background)',
          border: '1px solid var(--aurora-common-border)',
        }}
      >
        <GitBranch className="w-4 h-4" style={{ color: 'var(--aurora-common-primary)' }} />
        <span
          className="flex-1 text-left text-[13px] truncate"
          style={{ color: 'var(--aurora-sidebar-foreground)' }}
        >
          {currentBranch || 'No branch'}
        </span>
        <ChevronDown
          className="w-4 h-4 transition-transform"
          style={{
            color: 'var(--aurora-sidebar-foreground)',
            opacity: 0.6,
            transform: isOpen ? 'rotate(180deg)' : 'none',
          }}
        />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className="absolute top-full left-0 right-0 mt-1 py-1 rounded-lg shadow-xl z-50 max-h-[300px] overflow-y-auto"
          style={{
            background: 'var(--aurora-sidebar-background)',
            border: '1px solid var(--aurora-common-border)',
          }}
        >
          {/* Create Branch */}
          {isCreating ? (
            <div className="px-2 py-1">
              <input
                ref={inputRef}
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Branch name..."
                className="w-full px-2 py-1.5 text-[13px] rounded outline-none"
                style={{
                  background: 'var(--aurora-editor-background)',
                  color: 'var(--aurora-editor-foreground)',
                  border: '1px solid var(--aurora-common-primary)',
                }}
              />
            </div>
          ) : (
            <button
              onClick={() => setIsCreating(true)}
              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-white/5 transition-colors"
            >
              <Plus className="w-4 h-4" style={{ color: 'var(--aurora-common-primary)' }} />
              <span className="text-[13px]" style={{ color: 'var(--aurora-sidebar-foreground)' }}>
                Create new branch
              </span>
            </button>
          )}

          {/* Divider */}
          <div className="my-1 border-t" style={{ borderColor: 'var(--aurora-common-border)' }} />

          {/* Local Branches */}
          {localBranches.length > 0 && (
            <>
              <div className="px-3 py-1">
                <span
                  className="text-[10px] font-semibold uppercase"
                  style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}
                >
                  Local
                </span>
              </div>
              {localBranches.map((branch) => (
                <button
                  key={branch.name}
                  onClick={() => handleCheckout(branch.name, false)}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors"
                >
                  {branch.isCurrent ? (
                    <Check className="w-4 h-4" style={{ color: 'var(--aurora-common-success)' }} />
                  ) : (
                    <div className="w-4" />
                  )}
                  <span
                    className="text-[13px] truncate"
                    style={{
                      color: branch.isCurrent
                        ? 'var(--aurora-common-primary)'
                        : 'var(--aurora-sidebar-foreground)',
                    }}
                  >
                    {branch.name}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* Remote Branches */}
          {remoteBranches.length > 0 && (
            <>
              <div className="my-1 border-t" style={{ borderColor: 'var(--aurora-common-border)' }} />
              <div className="px-3 py-1">
                <span
                  className="text-[10px] font-semibold uppercase flex items-center gap-1"
                  style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}
                >
                  <Globe className="w-3 h-3" />
                  Remote
                </span>
              </div>
              {remoteBranches.map((branch) => (
                <button
                  key={branch.name}
                  onClick={() => handleCheckout(branch.name, true)}
                  className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 transition-colors"
                >
                  <div className="w-4" />
                  <span
                    className="text-[13px] truncate"
                    style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.7 }}
                  >
                    {branch.name}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default GitBranchSelector;
