import { useState } from 'react';
import { api } from '../lib/api';
import logo from '../assets/logo.png';

export default function LoginPage({ onLogin, onSkip }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setError('');
    // O2：邮箱格式前置校验（此前任意字符串直接提交，错误只能等服务端返回）
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (mode === 'register' && !username.trim()) {
      setError('请输入用户名');
      return;
    }
    if (!password) {
      setError('请输入密码');
      return;
    }
    setLoading(true);
    try {
      const body = mode === 'login' ? { email, password } : { email, username, password };
      const res = mode === 'login' ? await api.login(body) : await api.register(body);
      // 响应守卫：服务端 200 但未返回 token 时不得进入伪登录态
      // （localStorage 存 "undefined" 字符串，之后每个请求都 401，用户却停在主界面）
      if (!res?.token) throw new Error((res && res.error) || '登录响应异常，请稍后重试');
      onLogin(res.token);
    } catch (err) {
      setError(err.message || '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-bg">
      <div className="w-80">
        <img src={logo} className="w-14 h-14 mx-auto mb-4 rounded-2xl" alt="MJ Coder" />
        <h1 className="text-2xl font-semibold text-center mb-1">MJ Coder</h1>
        <p className="text-text2 text-xs text-center mb-8">今天想交付什么？</p>
        {error && <div className="text-danger text-xs mb-3 text-center">{error}</div>}
        <input placeholder="邮箱" value={email} onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-sm mb-3 outline-none focus:border-accent" />
        {mode === 'register' && (
          <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-sm mb-3 outline-none focus:border-accent" />
        )}
        <input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !loading && submit()}
          className="w-full bg-surface border border-border rounded-xl px-4 py-3 text-sm mb-4 outline-none focus:border-accent" />
        <button onClick={submit} disabled={loading}
          className="w-full bg-accent text-white rounded-xl py-3 text-sm font-medium hover:opacity-90 disabled:opacity-50">
          {loading ? '处理中...' : mode === 'login' ? '登录' : '创建账户'}
        </button>
        <div className="text-center mt-4">
          <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="text-text2 text-xs hover:text-text">
            {mode === 'login' ? '首次使用？创建账户' : '已有账户？直接登录'}
          </button>
        </div>
        {onSkip && (
          <div className="mt-6 pt-4 border-t border-border">
            <button onClick={onSkip} className="w-full text-text2 text-xs hover:text-text">
              跳过，直接进入离线模式
            </button>
            <p className="text-text2 text-[11px] text-center mt-2 leading-relaxed">
              离线模式不需要账户：会话与消息保存在本机，可直接使用本机模型或填入自己的模型服务地址。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
