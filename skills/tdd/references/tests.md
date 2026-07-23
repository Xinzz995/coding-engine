# 行为测试

## 判断标准

优先编写能从调用者视角回答“系统做了什么”的测试：

- 通过公共 API、CLI、HTTP 或 UI 入口进入；
- 观察调用者真正可见的返回值、状态或后续行为；
- 内部重命名、拆分或合并后仍应通过；
- 测试名称描述业务行为；
- 一个测试聚焦一个行为，失败时含义清楚。

期望值必须来自独立真相源，例如规格中的值、手工算例、固定样例或经确认的协议结果。
不要用与实现相同的算法在测试里重新计算期望值。

## 危险信号

- 直接测试私有函数或内部字段；
- 断言内部协作者的调用次数和顺序；
- 为了测试而暴露本不该公开的实现细节；
- 行为不变的重构导致大量测试改写；
- 只有“没有抛错”，没有验证结果；
- 测试先构造实现结果，再断言结果等于自己。

## 示例

```typescript
// 好：通过公共行为验证创建后可查询
test('创建用户后可以按 id 查询', async () => {
  const created = await api.createUser({ name: 'Alice' });
  const found = await api.getUser(created.id);
  expect(found.name).toBe('Alice');
});

// 差：把内部调用当成用户行为
test('createUser 调用 repository.save 一次', async () => {
  await createUser({ name: 'Alice' });
  expect(repository.save).toHaveBeenCalledTimes(1);
});
```
