// User Session
export interface UserSession {
  userId: string;
  socketId: string;
  username: string;
  color: string;
  cursorX: number;
  cursorY: number;
}

// Drawing Types
export interface Stroke {
  id: string;
  userId: string;
  username: string;
  points: Point[];
  color: string;
  size: number;
  opacity: number;
  tool: 'pen' | 'eraser' | 'line' | 'shape' | 'text';
  timestamp: number;
}

export interface Point {
  x: number;
  y: number;
  pressure?: number;
}

// Canvas
export interface Canvas {
  id: string;
  name: string;
  strokes: Stroke[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CanvasSnapshot {
  canvasId: string;
  strokes: Stroke[];
  savedAt: Date;
  savedBy: string;
}