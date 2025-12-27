/**
 * Drag-Drop State Store
 * Handles internal file/folder drag operations
 */

import { create } from 'zustand';

interface DragState {
  // Pending drag (before threshold is met)
  pendingPath: string | null;
  pendingName: string | null;
  startX: number;
  startY: number;

  // Active drag (after threshold is met)
  draggedPath: string | null;
  draggedName: string | null;
  isDragging: boolean;

  // Drop target
  dropTargetPath: string | null;
  dropTargetType: 'folder' | 'root' | 'editor' | null;

  // Mouse position for drag preview
  mouseX: number;
  mouseY: number;

  // Actions
  prepareDrag: (path: string, name: string, x: number, y: number) => void;
  startDrag: () => void;
  updateMouse: (x: number, y: number) => void;
  setDropTarget: (path: string | null, type: 'folder' | 'root' | 'editor' | null) => void;
  endDrag: () => void;
  cancelDrag: () => void;
}

const DRAG_THRESHOLD = 5; // pixels

export const useDragStore = create<DragState>((set, get) => ({
  pendingPath: null,
  pendingName: null,
  startX: 0,
  startY: 0,
  draggedPath: null,
  draggedName: null,
  isDragging: false,
  dropTargetPath: null,
  dropTargetType: null,
  mouseX: 0,
  mouseY: 0,

  prepareDrag: (path, name, x, y) => set({
    pendingPath: path,
    pendingName: name,
    startX: x,
    startY: y,
  }),

  startDrag: () => {
    const state = get();
    if (state.pendingPath && state.pendingName) {
      set({
        draggedPath: state.pendingPath,
        draggedName: state.pendingName,
        isDragging: true,
        pendingPath: null,
        pendingName: null,
      });
    }
  },

  updateMouse: (x, y) => {
    const state = get();
    // Check if we should start dragging (threshold met)
    if (state.pendingPath && !state.isDragging) {
      const dx = Math.abs(x - state.startX);
      const dy = Math.abs(y - state.startY);
      if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
        set({
          draggedPath: state.pendingPath,
          draggedName: state.pendingName,
          isDragging: true,
          pendingPath: null,
          pendingName: null,
          mouseX: x,
          mouseY: y,
        });
        return;
      }
    }
    if (state.isDragging) {
      set({ mouseX: x, mouseY: y });
    }
  },

  setDropTarget: (path, type) => set({
    dropTargetPath: path,
    dropTargetType: type,
  }),

  endDrag: () => set({
    pendingPath: null,
    pendingName: null,
    draggedPath: null,
    draggedName: null,
    isDragging: false,
    dropTargetPath: null,
    dropTargetType: null,
  }),

  cancelDrag: () => set({
    pendingPath: null,
    pendingName: null,
    draggedPath: null,
    draggedName: null,
    isDragging: false,
    dropTargetPath: null,
    dropTargetType: null,
  }),
}));
