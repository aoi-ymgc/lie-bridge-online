import React from "react";
import ReactDOM from "react-dom/client";
import { io } from "socket.io-client";
import App from "./App";
import "./styles.css";

const socket = io(import.meta.env.VITE_SERVER_URL ?? window.location.origin, {
  autoConnect: true
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App socket={socket} />
  </React.StrictMode>
);
