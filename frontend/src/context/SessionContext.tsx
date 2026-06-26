import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ChatMessage, MediaState } from '../types';

interface ScreenShareRequest {
  from: string;
  timestamp: number;
}

interface SessionContextType {
  sessionId: string | null;
  peerName: string | null;
  peerMediaState: MediaState | null;
  peerHasLeft: boolean;
  messages: ChatMessage[];
  screenShareRequest: ScreenShareRequest | null;
  currentScreenSharer: string | null;
  setSessionId: (id: string | null) => void;
  setPeerName: (name: string | null) => void;
  setPeerMediaState: (state: MediaState | null) => void;
  setPeerHasLeft: (hasLeft: boolean) => void;
  addMessage: (message: ChatMessage) => void;
  clearMessages: () => void;
  setScreenShareRequest: (request: ScreenShareRequest | null) => void;
  setCurrentScreenSharer: (sharer: string | null) => void;
}

const SessionContext = createContext<SessionContextType | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [peerMediaState, setPeerMediaState] = useState<MediaState | null>(null);
  const [peerHasLeft, setPeerHasLeft] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [screenShareRequest, setScreenShareRequest] = useState<ScreenShareRequest | null>(null);
  const [currentScreenSharer, setCurrentScreenSharer] = useState<string | null>(null);

  const addMessage = useCallback((message: ChatMessage) => {
    setMessages(prev => [...prev, message]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return (
    <SessionContext.Provider
      value={{
        sessionId,
        peerName,
        peerMediaState,
        peerHasLeft,
        messages,
        screenShareRequest,
        currentScreenSharer,
        setSessionId,
        setPeerName,
        setPeerMediaState,
        setPeerHasLeft,
        addMessage,
        clearMessages,
        setScreenShareRequest,
        setCurrentScreenSharer,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSessionContext() {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSessionContext must be used within SessionProvider');
  }
  return context;
}
