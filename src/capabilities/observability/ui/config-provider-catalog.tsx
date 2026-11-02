import { type ConfigProvider, matchesSearch, providerStatus, tableClass } from './config-model';

type Model = NonNullable<ConfigProvider['models']>[number];
const capability = (value: boolean | 'unknown' | undefined) =>
  value === true ? '支持' : value === false ? '不支持' : '未知';
const amount = (value: number | null | undefined) => (value == null ? '未知' : String(value));

function ModelFacts({ model: m }: { model: Model }) {
  return (
    <tr>
      <th scope="row">
        <code>{m.id}</code>
        <p>
          {m.runnable === true
            ? '目录允许运行'
            : m.runnable === false
              ? '当前不可运行'
              : '可运行性未知'}
        </p>
      </th>
      <td>
        {m.api ?? '协议未知'}
        <p>
          输入：
          {m.input?.map((value) => (value === 'unknown' ? '未知' : value)).join('、') || '未知'}
        </p>
      </td>
      <td>
        <dl className="un-config-facts">
          <dt>工具调用</dt>
          <dd>{capability(m.tool_call)}</dd>
          <dt>推理</dt>
          <dd>{capability(m.reasoning)}</dd>
          <dt>结构化输出</dt>
          <dd>{capability(m.structured_output)}</dd>
          <dt>图像</dt>
          <dd>{capability(m.vision)}</dd>
          <dt>强制工具选择</dt>
          <dd>{capability(m.forced_tool_choice)}</dd>
        </dl>
      </td>
      <td>
        <dl className="un-config-facts">
          <dt>上下文</dt>
          <dd>{amount(m.context_window_tokens)}</dd>
          <dt>输入上限</dt>
          <dd>{amount(m.max_input_tokens)}</dd>
          <dt>输出上限</dt>
          <dd>{amount(m.max_output_tokens)}</dd>
        </dl>
        <p>单位：token</p>
      </td>
      <td>
        {m.cost ? (
          <dl className="un-config-facts">
            <dt>输入</dt>
            <dd>{amount(m.cost.input)}</dd>
            <dt>输出</dt>
            <dd>{amount(m.cost.output)}</dd>
            <dt>缓存读取</dt>
            <dd>{amount(m.cost.cache_read)}</dd>
            <dt>缓存写入</dt>
            <dd>{amount(m.cost.cache_write)}</dd>
          </dl>
        ) : (
          '未知，不表示免费'
        )}
      </td>
    </tr>
  );
}

export function ConfigProviderCatalog({
  providers,
  query,
}: {
  providers: ConfigProvider[];
  query: string;
}) {
  const visible = providers.filter((p) =>
    matchesSearch(
      query,
      p.name,
      p.pi_provider,
      providerStatus(p),
      p.models?.map((m) => m.id),
    ),
  );
  return (
    <section className="un-config-catalog" aria-label="Provider 与模型目录">
      <h2>Provider 与模型目录</h2>
      <p>“已配置”表示凭据已配置，不保证每个模型都能调用；能力未知不等于不支持。</p>
      <details className="un-config-catalog-note">
        <summary>目录更新与来源：当前未提供</summary>
        <p>
          目录版本、拉取时间、缓存或随包兜底来源尚未提供，当前是否使用降级目录未知。配置快照的版本与读取时间不是目录版本或更新时间。
        </p>
        <p>API base URL、思考强度档位也未提供，不从模型名称或 SDK 默认值推测。</p>
      </details>
      {!visible.length && <p>没有匹配的 provider 或模型。</p>}
      {visible.map((p) => (
        <details className="un-config-provider" key={p.name}>
          <summary>
            <strong>{p.name}</strong>
            <span data-auth={p.auth?.status}>{providerStatus(p)}</span>
            <span>{p.models ? `${p.models.length} 个目录模型` : '模型目录未知'}</span>
          </summary>
          <div className="un-config-provider-body">
            <dl className="un-config-provider-facts">
              <dt>认证方式</dt>
              <dd>{p.auth_mode}</dd>
              <dt>凭据</dt>
              <dd>{p.key_present ? '服务端已配置' : '服务端未配置'}</dd>
              <dt>原生身份</dt>
              <dd>{p.pi_provider ?? '未提供'}</dd>
              <dt>执行通道</dt>
              <dd>
                {p.implemented_for
                  ? `chat：${p.implemented_for.chat ? '已接线' : '未接线'}；typed：${p.implemented_for.typed ? '已接线' : '未接线'}`
                  : '通道明细未提供'}
              </dd>
            </dl>
            {p.auth?.status === 'auth_failed' && (
              <p className="un-config-auth-error">
                认证失败 · HTTP {p.auth.http_status ?? '未知'} · 错误类型：
                {p.auth.error_type ?? '未知'}。这里只显示已有结果，不发起认证探针。
              </p>
            )}
            {p.models?.length ? (
              <section
                className="un-config-table-scroll"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to scroll the wide capability table.
                tabIndex={0}
                aria-label={`${p.name} 模型能力表`}
              >
                <table className={tableClass}>
                  <caption>{p.name} · 全量目录能力与限额；费率单位 USD / 百万 token</caption>
                  <thead>
                    <tr>
                      <th scope="col">模型 / 可运行性</th>
                      <th scope="col">协议 / 输入</th>
                      <th scope="col">能力</th>
                      <th scope="col">限额</th>
                      <th scope="col">目录费率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.models.map((m) => (
                      <ModelFacts key={m.id} model={m} />
                    ))}
                  </tbody>
                </table>
              </section>
            ) : (
              <p>{p.models ? '目录未列出模型。' : '模型目录尚未提供。'}</p>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}
