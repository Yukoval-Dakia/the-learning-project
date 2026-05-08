import { Route, Routes } from 'react-router-dom';
import { Home } from './routes/index';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
    </Routes>
  );
}
