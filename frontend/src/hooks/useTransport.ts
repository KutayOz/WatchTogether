import { useEffect, useCallback } from 'react';
import { transportService, type TransportEventHandlers } from '../services/transportService';
import type { MediaState, QualityFeedback, ShareStatus } from '../types';

/**
 * Replaces useSignalR. The returned object has the same method names, so
 * SessionRoom's signalRRef and everything reached through it (usePeerPresence,
 * useWatchTogether) work unchanged.
 *
 * One real difference: there is no connect-on-mount. The socket URL carries the
 * session id, so there is nothing to connect to until joinSession is called —
 * which is also what makes reconnecting equal to rejoining.
 *
 * @param isAuthenticated Gates nothing at connect time any more, but kept so
 *   the call site still reads as "only wire this up for a logged-in user"; the
 *   auth cookie travels with the WebSocket handshake and the Worker rejects the
 *   upgrade without it.
 */
export function useTransport(isAuthenticated: boolean, handlers: TransportEventHandlers) {
  // No dependency array on purpose. The handler object closes over component
  // state and is rebuilt every render, so reinstalling it every render is what
  // keeps the callbacks from going stale — the same reason useSignalR kept them
  // in a ref, minus the write-during-render that ref needed.
  useEffect(() => {
    transportService.setHandlers(handlers);
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    return () => {
      // Leaving on unmount also cancels any scheduled reconnect, so navigating
      // away mid-flap does not quietly reopen a socket behind the user.
      transportService.leaveSession('');
    };
  }, [isAuthenticated]);

  const joinSession = useCallback((sessionId: string) => {
    return transportService.joinSession(sessionId);
  }, []);

  const leaveSession = useCallback((sessionId: string) => {
    return transportService.leaveSession(sessionId);
  }, []);

  const sendOffer = useCallback((sessionId: string, sdpOffer: string) => {
    return transportService.sendOffer(sessionId, sdpOffer);
  }, []);

  const sendAnswer = useCallback((sessionId: string, sdpAnswer: string) => {
    return transportService.sendAnswer(sessionId, sdpAnswer);
  }, []);

  const sendIceCandidate = useCallback((sessionId: string, candidate: string) => {
    return transportService.sendIceCandidate(sessionId, candidate);
  }, []);

  const sendChatMessage = useCallback((sessionId: string, message: string) => {
    return transportService.sendChatMessage(sessionId, message);
  }, []);

  const notifyMediaStateChange = useCallback((sessionId: string, state: MediaState) => {
    return transportService.notifyMediaStateChange(sessionId, state);
  }, []);

  const notifyTyping = useCallback((sessionId: string) => {
    return transportService.notifyTyping(sessionId);
  }, []);

  const notifyVideoSync = useCallback((sessionId: string, action: string, payload: string) => {
    return transportService.notifyVideoSync(sessionId, action, payload);
  }, []);

  const notifyReaction = useCallback((sessionId: string, emoji: string) => {
    return transportService.notifyReaction(sessionId, emoji);
  }, []);

  const notifyCursor = useCallback((sessionId: string, x: number, y: number) => {
    return transportService.notifyCursor(sessionId, x, y);
  }, []);

  const requestScreenShare = useCallback((sessionId: string) => {
    return transportService.requestScreenShare(sessionId);
  }, []);

  const respondScreenShare = useCallback((sessionId: string, approved: boolean) => {
    return transportService.respondScreenShare(sessionId, approved);
  }, []);

  const stopScreenShare = useCallback((sessionId: string) => {
    return transportService.stopScreenShare(sessionId);
  }, []);

  const notifyScreenShareStarted = useCallback((sessionId: string, streamId: string) => {
    return transportService.notifyScreenShareStarted(sessionId, streamId);
  }, []);

  const sendRenegotiationOffer = useCallback((sessionId: string, sdpOffer: string) => {
    return transportService.sendRenegotiationOffer(sessionId, sdpOffer);
  }, []);

  const sendRenegotiationAnswer = useCallback((sessionId: string, sdpAnswer: string) => {
    return transportService.sendRenegotiationAnswer(sessionId, sdpAnswer);
  }, []);

  const sendShareStatus = useCallback((sessionId: string, status: ShareStatus) => {
    return transportService.sendShareStatus(sessionId, status);
  }, []);

  const sendQualityFeedback = useCallback((sessionId: string, feedback: QualityFeedback) => {
    return transportService.sendQualityFeedback(sessionId, feedback);
  }, []);

  return {
    isConnected: transportService.isConnected,
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
    sendShareStatus,
  };
}
