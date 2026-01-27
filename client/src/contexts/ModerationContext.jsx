import React, { useContext, useState, useCallback, useEffect } from 'react';
import { ModerationContext } from '../components/ChatMessage';

export function ModerationProvider({ children, socket }) {
  // Highlighted messages (visual marker in feed)
  const [highlightedIds, setHighlightedIds] = useState(new Set());

  // Queue of messages waiting to be featured
  const [queue, setQueue] = useState([]);

  // Currently featured message (shown prominently on display)
  const [featuredMessage, setFeaturedMessage] = useState(null);

  // Listen for moderation events from socket (syncs across windows)
  useEffect(() => {
    if (!socket) return;

    socket.on('moderationUpdate', (data) => {
      if (data.highlightedIds) {
        setHighlightedIds(new Set(data.highlightedIds));
      }
      if (data.queue !== undefined) {
        setQueue(data.queue);
      }
      if (data.featuredMessage !== undefined) {
        setFeaturedMessage(data.featuredMessage);
      }
    });

    // Request current state on connect
    socket.emit('getModerationState');

    socket.on('moderationState', (data) => {
      setHighlightedIds(new Set(data.highlightedIds || []));
      setQueue(data.queue || []);
      setFeaturedMessage(data.featuredMessage || null);
    });

    return () => {
      socket.off('moderationUpdate');
      socket.off('moderationState');
    };
  }, [socket]);

  // Broadcast changes to server
  const broadcastUpdate = useCallback((update) => {
    if (socket) {
      socket.emit('moderationUpdate', update);
    }
  }, [socket]);

  // Toggle highlight on a message
  const toggleHighlight = useCallback((message) => {
    setHighlightedIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(message.id)) {
        newSet.delete(message.id);
      } else {
        newSet.add(message.id);
      }
      broadcastUpdate({ highlightedIds: Array.from(newSet) });
      return newSet;
    });
  }, [broadcastUpdate]);

  // Add message to queue
  const addToQueue = useCallback((message) => {
    setQueue(prev => {
      // Don't add duplicates
      if (prev.find(m => m.id === message.id)) return prev;
      const newQueue = [...prev, { ...message, queuedAt: new Date().toISOString() }];
      broadcastUpdate({ queue: newQueue });
      return newQueue;
    });
  }, [broadcastUpdate]);

  // Remove message from queue
  const removeFromQueue = useCallback((messageId) => {
    setQueue(prev => {
      const newQueue = prev.filter(m => m.id !== messageId);
      broadcastUpdate({ queue: newQueue });
      return newQueue;
    });
  }, [broadcastUpdate]);

  // Reorder queue
  const reorderQueue = useCallback((fromIndex, toIndex) => {
    setQueue(prev => {
      const newQueue = [...prev];
      const [removed] = newQueue.splice(fromIndex, 1);
      newQueue.splice(toIndex, 0, removed);
      broadcastUpdate({ queue: newQueue });
      return newQueue;
    });
  }, [broadcastUpdate]);

  // Feature a message (show on display)
  const featureMessage = useCallback((message) => {
    setFeaturedMessage(message);
    broadcastUpdate({ featuredMessage: message });
    // Also remove from queue if it was there
    removeFromQueue(message.id);
  }, [broadcastUpdate, removeFromQueue]);

  // Clear featured message
  const clearFeatured = useCallback(() => {
    setFeaturedMessage(null);
    broadcastUpdate({ featuredMessage: null });
  }, [broadcastUpdate]);

  // Quick action: highlight and add to queue
  const quickQueue = useCallback((message) => {
    toggleHighlight(message);
    addToQueue(message);
  }, [toggleHighlight, addToQueue]);

  // Feature next item in queue
  const featureNext = useCallback(() => {
    if (queue.length > 0) {
      featureMessage(queue[0]);
    }
  }, [queue, featureMessage]);

  const value = {
    highlightedIds,
    queue,
    featuredMessage,
    toggleHighlight,
    addToQueue,
    removeFromQueue,
    reorderQueue,
    featureMessage,
    clearFeatured,
    quickQueue,
    featureNext,
    isHighlighted: (id) => highlightedIds.has(id),
    isQueued: (id) => queue.some(m => m.id === id),
  };

  return (
    <ModerationContext.Provider value={value}>
      {children}
    </ModerationContext.Provider>
  );
}

export function useModeration() {
  const context = useContext(ModerationContext);
  if (!context) {
    throw new Error('useModeration must be used within a ModerationProvider');
  }
  return context;
}
