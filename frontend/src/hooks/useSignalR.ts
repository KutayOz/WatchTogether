import { logger } from '../services/logger';
import { useEffect, useCallback, useRef } from 'react';
import { signalRService, type SignalREventHandlers } from '../services/signalRService';
import type { MediaState, QualityFeedback } from '../types';

/**
 * @param isAuthenticated Whether the user is logged in. Used to gate the
 *   connection attempt — calling .connect() before login would hit a 401 on
 *   the WebSocket handshake. The underlying transport now relies on the
 *   HttpOnly auth cookie (withCredentials:true) so no token is passed here.
 */
export function useSignalR(isAuthenticated: boolean, handlers: SignalREventHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!isAuthenticated) return;

    const connect = async () => {
      try {
        signalRService.setHandlers(handlersRef.current);
        await signalRService.connect();
      } catch (error) {
        logger.error('SignalR connection error:', error);
      }
    };

    connect();

    return () => {
      signalRService.disconnect();
    };
  }, [isAuthenticated]);

  useEffect(() => {
    signalRService.setHandlers(handlersRef.current);
  }, [handlers]);

  const joinSession = useCallback(async (sessionId: string) => {
    return signalRService.joinSession(sessionId);
  }, []);

  const leaveSession = useCallback(async (sessionId: string) => {
    return signalRService.leaveSession(sessionId);
  }, []);

  const sendOffer = useCallback(async (sessionId: string, sdpOffer: string) => {
    return signalRService.sendOffer(sessionId, sdpOffer);
  }, []);

  const sendAnswer = useCallback(async (sessionId: string, sdpAnswer: string) => {
    return signalRService.sendAnswer(sessionId, sdpAnswer);
  }, []);

  const sendIceCandidate = useCallback(async (sessionId: string, candidate: string) => {
    return signalRService.sendIceCandidate(sessionId, candidate);
  }, []);

  const sendChatMessage = useCallback(async (sessionId: string, message: string) => {
    return signalRService.sendChatMessage(sessionId, message);
  }, []);

  const notifyMediaStateChange = useCallback(async (sessionId: string, state: MediaState) => {
    return signalRService.notifyMediaStateChange(sessionId, state);
  }, []);

  const notifyTyping = useCallback(async (sessionId: string) => {
    return signalRService.notifyTyping(sessionId);
  }, []);

  const notifyVideoSync = useCallback(async (sessionId: string, action: string, payload: string) => {
    return signalRService.notifyVideoSync(sessionId, action, payload);
  }, []);

  const notifyReaction = useCallback(async (sessionId: string, emoji: string) => {
    return signalRService.notifyReaction(sessionId, emoji);
  }, []);

  const notifyCursor = useCallback(async (sessionId: string, x: number, y: number) => {
    return signalRService.notifyCursor(sessionId, x, y);
  }, []);

  const requestScreenShare = useCallback(async (sessionId: string) => {
    return signalRService.requestScreenShare(sessionId);
  }, []);

  const respondScreenShare = useCallback(async (sessionId: string, approved: boolean) => {
    return signalRService.respondScreenShare(sessionId, approved);
  }, []);

  const stopScreenShare = useCallback(async (sessionId: string) => {
    return signalRService.stopScreenShare(sessionId);
  }, []);

  const notifyScreenShareStarted = useCallback(async (sessionId: string, streamId: string) => {
    return signalRService.notifyScreenShareStarted(sessionId, streamId);
  }, []);

  const sendRenegotiationOffer = useCallback(async (sessionId: string, sdpOffer: string) => {
    return signalRService.sendRenegotiationOffer(sessionId, sdpOffer);
  }, []);

  const sendRenegotiationAnswer = useCallback(async (sessionId: string, sdpAnswer: string) => {
    return signalRService.sendRenegotiationAnswer(sessionId, sdpAnswer);
  }, []);

  const sendQualityFeedback = useCallback(async (sessionId: string, feedback: QualityFeedback) => {
    return signalRService.sendQualityFeedback(sessionId, feedback);
  }, []);

  return {
    isConnected: signalRService.isConnected,
    joinSession,
    leaveSession,
    sendOffer,
    sendAnswer,
    sendIceCandidate,
    sendChatMessage,
    notifyMediaStateChange,
    notifyTyping,
    notifyVideoSync,
    notifyReaction,
    notifyCursor,
    requestScreenShare,
    respondScreenShare,
    stopScreenShare,
    notifyScreenShareStarted,
    sendRenegotiationOffer,
    sendRenegotiationAnswer,
    sendQualityFeedback,
  };
}
