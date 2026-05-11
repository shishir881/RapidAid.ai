import { useEffect, useState, useRef } from 'react';
import { WS_URL } from '@/lib/api';

export function useWebSocket(path: string | null) {
  const [lastMessage, setLastMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const ws = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef(0);

  useEffect(() => {
    if (!path) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (cancelled) return;

      const url = `${WS_URL}${path}`;
      const socket = new WebSocket(url);
      ws.current = socket;

      socket.onopen = () => {
        reconnectAttempt.current = 0;
        console.log(`Connected to WS: ${url}`);
        setIsConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);
        } catch (e) {
          console.error('Failed to parse WS message', event.data);
        }
      };

      socket.onerror = () => {
        socket.close();
      };

      socket.onclose = () => {
        setIsConnected(false);
        if (cancelled) return;
        reconnectAttempt.current += 1;
        const delayMs = Math.min(30_000, 800 * Math.pow(2, Math.min(reconnectAttempt.current, 6)));
        console.log(`Disconnected from WS: ${url}, retry in ${delayMs}ms`);
        retryTimer = setTimeout(connect, delayMs);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
    };
  }, [path]);

  const sendMessage = (msg: object) => {
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify(msg));
    } else {
      console.error('WebSocket is not open. Cannot send message.');
    }
  };

  return { lastMessage, isConnected, sendMessage };
}
