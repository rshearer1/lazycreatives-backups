import { useState } from "react";
import { Nav } from "./components/Nav";
import { Dashboard } from "./screens/Dashboard";
import { Sources } from "./screens/Sources";
import { Scan } from "./screens/Scan";
import { Backup } from "./screens/Backup";
import { Browse } from "./screens/Browse";

export type Screen = "dashboard" | "sources" | "scan" | "backup" | "browse";

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  return (
    <div className="app">
      <Nav screen={screen} onNavigate={setScreen} />
      <div className="main">
        {screen === "dashboard" && <Dashboard />}
        {screen === "sources" && <Sources />}
        {screen === "scan" && <Scan onBackupStarted={() => setScreen("backup")} />}
        {screen === "backup" && <Backup />}
        {screen === "browse" && <Browse />}
      </div>
    </div>
  );
}
