export function Scan({ onBackupStarted }: { onBackupStarted: () => void }) {
  return (<><h1>Scan & Back up</h1><p className="sub">Discover projects.</p>
    <button onClick={onBackupStarted}>go</button></>);
}
