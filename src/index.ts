import { Context, Schema, h } from 'koishi'

import '@koishijs/plugin-proxy-agent'

export const name = 'sc2arcade-search'

export interface Config {
  proxyAgent: string
  sensitiveword: boolean
  checkHandle: boolean  // 新增：是否开启绑定句柄检测
}

export const Config: Schema<Config> = Schema.object({
  proxyAgent: Schema.string().description('代理服务器地址'),
  sensitiveword: Schema.boolean().description('是否启用敏感词过滤功能').default(true),
  checkHandle: Schema.boolean().description('是否开启绑定句柄检测').default(true),  // 新增配置项
})

export const inject = {
  required: ['database'],
}

declare module 'koishi' {
  interface Tables {
    sc2arcade_player: player
    sc2arcade_map: map
    sc2arcade_sensitiveword: sensitiveName // 新增敏感词表
  }
}

// 这里是新增表的接口类型
export interface player {
  id: number // 新增自增主键
  userId: string
  regionId: number
  realmId: number
  profileId: number
  createdAt: Date
  isActive: boolean // 新增字段，标记当前使用的句柄
}

export interface map {
  guildId: string
  regionId: number
  mapId: number
  createdAt: Date
}

// 新增敏感词表类型
export interface sensitiveName {
  name: string
  isSensitive: boolean
  lastdate: Date
}

export function apply(ctx: Context, config: Config) {
  // write your plugin here

  ctx.model.extend('sc2arcade_player', {
    // 各字段的类型声明
    id: 'unsigned', // 新增自增主键
    userId: 'string',
    regionId: 'unsigned',
    realmId: 'unsigned',
    profileId: 'unsigned',
    createdAt: 'timestamp',
    isActive: 'boolean', // 新增字段
  }, {
    autoInc: true, // 启用自增主键
    primary: 'id' // 设置主键为 id
  })

  ctx.model.extend('sc2arcade_map', {
    guildId: 'string',
    regionId: 'unsigned',
    mapId: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'guildId'
  })

  // 添加敏感词数据表
  ctx.model.extend('sc2arcade_sensitiveword', {
    name: 'string',
    isSensitive: 'boolean',
    lastdate: 'timestamp',
  }, {
    primary: 'name' // 使用name作为主键
  })

  // 辅助函数：获取区域名称
  function getRegionName(regionId: number): string {
    const regionMap = {
      1: '[US]',
      2: '[EU]',
      3: '[KR]',
      5: '[CN]'
    }
    return regionMap[regionId] || `[${regionId}]`
  }

  // 辅助函数：格式化句柄显示
  function formatHandle(handle: player, isActive = false): string {
    const region = getRegionName(handle.regionId)
    const activeMark = isActive ? ' (当前使用)' : ''
    return `${region} ${handle.regionId}-S2-${handle.realmId}-${handle.profileId}${activeMark}`
  }

  ctx.guild()
    .command('sc2arcade/房间', '查询正在等待的房间')
    .action(async (argv) => {
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords; // 解构赋值获取第一个元素
        const { regionId, mapId } = mapRecord; // 解构赋值提取属性
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/history?regionId=${regionId}&mapId=${mapId}&orderDirection=desc&includeSlots=true`,
          config.proxyAgent
        );

        return await lobbiesHistory(ctx, config, response, 'open');
      } catch (error) {
        console.error('查询房间命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.guild()
    .command('sc2arcade/历史房间', '查询已经开始的房间')
    .action(async (argv) => {
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords; // 解构赋值获取第一个元素
        const { regionId, mapId } = mapRecord; // 解构赋值提取属性
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/history?regionId=${regionId}&mapId=${mapId}&orderDirection=desc&includeSlots=true`,
          config.proxyAgent
        );

        return await lobbiesHistory(ctx, config, response, 'started');
      } catch (error) {
        console.error('查询历史房间命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.guild()
    .command('sc2arcade/场数排行', '查询游玩地图的场数排行榜')
    .alias('场次排行')
    .action(async (argv) => {
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords; // 解构赋值获取第一个元素
        const { regionId, mapId } = mapRecord; // 解构赋值提取属性
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/maps/${regionId}/${mapId}/player-base?orderBy=lobbiesStarted&orderDirection=desc`,
          config.proxyAgent
        );

        return await mapsplayerbase(response);
      } catch (error) {
        console.error('查询场数排行命令时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 修改大厅指令
  ctx.command('sc2arcade/大厅 [regionId]', '查询大厅中正在等待的房间')
    .action(async (argv, regionId) => {
      const session = argv.session;
      if (!regionId) {
        await session.send(`<quote id="${session.messageId}"/>请在30秒内输入区域ID:\n(可用的区域ID: US, EU, KR, CN)`)

        regionId = await session.prompt(30000)
        if (!regionId) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
      }
      // 验证区域ID
      const validRegionIds = ['US', 'EU', 'KR', 'CN'];
      if (!validRegionIds.includes(regionId.toUpperCase())) {
        return `<quote id="${session.messageId}"/>❌ 区域ID错误, 请重新输入。\n(可用的区域ID: US, EU, KR, CN)`;
      }

      // 映射区域ID到区域代码和名称
      const regionCodeMap = {
        US: { code: 1, name: '[US]' },
        EU: { code: 2, name: '[EU]' },
        KR: { code: 3, name: '[KR]' },
        CN: { code: 5, name: '[CN]' }
      };
      const regionInfo = regionCodeMap[regionId.toUpperCase()];
      const regionCode = regionInfo.code;
      const regionName = regionInfo.name;

      try {
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/active?regionId=${regionCode}&includeMapInfo=true`,
          config.proxyAgent
        );

        return `<quote id="${session.messageId}"/>` + lobbiesActive(response, regionName);
      } catch (error) {
        console.error('查询大厅信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 修改后的句柄查询指令
  ctx.command('sc2arcade/句柄 [user]', '查询已经绑定的星际争霸2游戏句柄')
    .usage('user 参数为选填项')
    .example('/句柄, 查询自己绑定的游戏句柄\n    /句柄 @用户, 查询其他用户绑定的游戏句柄')
    .action(async (argv, user) => {
      const session = argv.session;
      try {
        if (!user) {
          // 获取完整记录，而不是只选择部分字段
          const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

          if (!handles || handles.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
          }

          const message = handles.map((h, index) =>
            `${index + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          return `<quote id="${session.messageId}"/>您绑定的游戏句柄：\n${message}`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"句柄 @用户"查询其他用户绑定的游戏句柄。`
          }
          const targetUserId = parsedUser.attrs.id;
          // 获取完整记录，而不是只选择部分字段
          const handles = await ctx.database.get('sc2arcade_player', { userId: targetUserId });

          if (!handles || handles.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄。`;
          }

          const message = handles.map((h, index) =>
            `${index + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          return `<quote id="${session.messageId}"/>对方绑定的游戏句柄：\n${message}`;
        }
      } catch (error) {
        console.error('查询句柄信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 新增切换句柄指令
  ctx.command('sc2arcade/切换 [index]', '切换正在使用的游戏句柄')
    .action(async (argv, indexParam) => { // 将参数名改为 indexParam 避免混淆
      const session = argv.session;
      try {
        const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

        if (!handles || handles.length === 0) {
          return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
        }

        let index: number | null = null;

        if (!indexParam) {
          // 显示所有句柄让用户选择
          const message = handles.map((h, i) =>
            `${i + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          await session.send(`<quote id="${session.messageId}"/>请选择要切换的句柄：\n${message}\n\n回复序号进行切换`);

          const choice = await session.prompt(30000);
          if (!choice) return `<quote id="${session.messageId}"/>已取消操作。`;

          // 将用户输入的字符串转换为数字
          index = parseInt(choice);
        } else {
          // 将参数转换为数字
          index = parseInt(indexParam);
        }

        // 检查转换后的值是否有效
        if (isNaN(index) || index < 1 || index > handles.length) {
          return `<quote id="${session.messageId}"/>❌ 序号无效，请输入1-${handles.length}之间的数字。`;
        }

        const selectedHandle = handles[index - 1];

        // 更新所有句柄状态
        await Promise.all(handles.map(handle =>
          ctx.database.set('sc2arcade_player', { id: handle.id }, { isActive: handle.id === selectedHandle.id })
        ));

        return `<quote id="${session.messageId}"/>✅ 已切换到句柄：${formatHandle(selectedHandle)}`;
      } catch (error) {
        console.error('切换句柄时发生错误:', error);
        return '⚠️ 切换失败，请稍后尝试。';
      }
    });

  ctx.command('sc2arcade/查询 [handle]', '查询星际争霸2游戏句柄是否被绑定')
    .action(async (argv, handle) => {
      const session = argv.session; // 获取 Session 对象
      try {
        if (!handle) {
          await session.send(`<quote id="${session.messageId}"/>请在30秒内输入游戏句柄:\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])`)

          handle = await session.prompt(30000)
          if (!handle) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
        }

        // 验证handle格式
        const handleRegex = /^([1235])-S2-([12])-(\d+)$/;
        if (!handleRegex.test(handle)) {
          return `<quote id="${session.messageId}"/>❌ 游戏句柄格式错误, 请重新输入。\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])`;
        }

        const [, regionId, realmId, profileId] = handle.match(handleRegex)!.map(Number);

        // 新增检查：检测是否已被其他用户绑定
        const existingHandle = await ctx.database.get('sc2arcade_player', {
          regionId,
          realmId,
          profileId
        });
        if (existingHandle.length > 0) {
          return `<quote id="${session.messageId}"/>该游戏句柄已被 ${existingHandle[0].userId} 绑定。`;
        }
        else {
          return `<quote id="${session.messageId}"/>该游戏句柄暂未被其他用户绑定。`
        }

      } catch (error) {
        console.error('查询句柄信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 修改战绩指令使用当前活跃句柄
  ctx.command('sc2arcade/战绩 [user]', '查询近20场的游戏战绩')
    .usage('user 参数为选填项')
    .example('/战绩, 查询自己的游戏战绩\n    /战绩 @用户, 查询其他用户的游戏战绩')
    .action(async (argv, user) => {
      const session = argv.session;
      try {
        if (!user) {
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: session.userId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/matches?orderDirection=desc`,
            config.proxyAgent
          );

          const history = profilesMatches(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的战绩。`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"战绩 @用户"查询其他用户的游戏战绩。`
          }
          const targetUserId = parsedUser.attrs.id;
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: targetUserId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/matches?orderDirection=desc`,
            config.proxyAgent
          );

          const history = profilesMatches(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的战绩。`;
        }
      } catch (error) {
        console.error('查询战绩失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 修改场数指令使用当前活跃句柄
  ctx.command('sc2arcade/场数 [user]', '查询游玩所有地图的场数')
    .alias('场次')
    .usage('user 参数为选填项')
    .example('/场数, 查询自己游玩的所有地图的场数\n    /场数 @用户, 查询其他用户游玩的所有地图的场数')
    .action(async (argv, user) => {
      const session = argv.session;
      try {
        if (!user) {
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: session.userId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的场数。`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"场数 @用户"查询其他用户游玩的所有地图的累计场数排行榜。`
          }
          const targetUserId = parsedUser.attrs.id;
          const activeHandle = await ctx.database.get('sc2arcade_player', {
            userId: targetUserId,
            isActive: true
          });

          if (!activeHandle || activeHandle.length === 0) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄或未设置活跃句柄。`;
          }

          const { regionId, realmId, profileId } = activeHandle[0];
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的场数。`;
        }
      } catch (error) {
        console.error('查询游戏场数失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

    // 修改后的绑定指令
  ctx.command('sc2arcade/绑定 [handle]', '绑定星际争霸2游戏句柄')
    .alias('绑定句柄')
    .usage('游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID]')
    .action(async (argv, handle) => {
      const session = argv.session;
      if (!handle) {
        await session.send(`<quote id="${session.messageId}"/>请在30秒内输入游戏句柄:\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])\n例如：5-S2-1-1234567`)
        handle = await session.prompt(30000)
        if (!handle) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
      }

      const handleRegex = /^([1235])-s2-([12])-(\d+)$/i;
      if (!handleRegex.test(handle)) {
        return `<quote id="${session.messageId}"/>❌ 游戏句柄格式错误, 请重新输入。\n(游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID])\n例如：5-S2-1-1234567`;
      }

      const standardizedHandle = handle.replace(/-s2-/i, '-S2-');
      const [, regionId, realmId, profileId] = standardizedHandle.match(handleRegex)!.map(Number);

      // 检查是否已被其他用户绑定
      const existingHandle = await ctx.database.get('sc2arcade_player', {
        regionId,
        realmId,
        profileId
      });

      if (existingHandle.length > 0) {
        return `<quote id="${session.messageId}"/>❌ 绑定失败, 该游戏句柄已被其他用户绑定。`;
      }

      // 检查是否已被当前用户绑定
      const userHandles = await ctx.database.get('sc2arcade_player', { userId: session.userId });
      const alreadyBound = userHandles.some(h =>
        h.regionId === regionId &&
        h.realmId === realmId &&
        h.profileId === profileId
      );

      if (alreadyBound) {
        return `<quote id="${session.messageId}"/>❌ 您已绑定过该游戏句柄。`;
      }

      try {
        // 根据配置决定是否进行句柄检测
        if (config.checkHandle) {
          // 查询句柄信息进行检测
          await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}`,
            config.proxyAgent
          );
        }

        // 判断是否是第一个句柄
        const isFirstHandle = userHandles.length === 0;

        // 执行绑定操作
        await ctx.database.create('sc2arcade_player', {
          userId: session.userId,
          regionId,
          realmId,
          profileId,
          isActive: isFirstHandle,
          createdAt: new Date()
        });

        const checkStatus = config.checkHandle ? '并已通过验证' : '（未验证句柄有效性）';
        return `<quote id="${session.messageId}"/>✅ 您已成功绑定游戏句柄${isFirstHandle ? '并设为当前使用' : ''}${checkStatus}。`;
      } catch (error) {
        // 只有当开启检测时才检查404错误
        if (config.checkHandle && error.response && error.response.status === 404) {
          return `<quote id="${session.messageId}"/>❌ 绑定失败, 您尝试绑定的游戏句柄不存在。`;
        }
        console.error('查询或绑定失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 修改后的解绑指令
  ctx.command('sc2arcade/解绑 [index]', '解除绑定星际争霸2游戏句柄')
    .alias('解绑句柄')
    .action(async (argv, indexParam) => { // 将参数名改为 indexParam
      const session = argv.session;
      try {
        const handles = await ctx.database.get('sc2arcade_player', { userId: session.userId });

        if (handles.length === 0) {
          return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
        }

        let index: number | null = null;

        if (!indexParam) {
          // 显示所有句柄让用户选择
          const message = handles.map((h, i) =>
            `${i + 1}. ${formatHandle(h, h.isActive)}`
          ).join('\n');

          await session.send(`<quote id="${session.messageId}"/>请选择要解绑的句柄：\n${message}\n\n回复序号进行解绑`);

          const choice = await session.prompt(30000);
          if (!choice) return `<quote id="${session.messageId}"/>已取消操作。`;

          index = parseInt(choice);
        } else {
          index = parseInt(indexParam);
        }

        // 检查转换后的值是否有效
        if (isNaN(index) || index < 1 || index > handles.length) {
          return `<quote id="${session.messageId}"/>❌ 序号无效，请输入1-${handles.length}之间的数字。`;
        }

        const handleToRemove = handles[index - 1];
        const wasActive = handleToRemove.isActive;

        // 删除句柄
        await ctx.database.remove('sc2arcade_player', { id: handleToRemove.id });

        // 如果解绑的是活跃句柄且还有其他句柄
        if (wasActive && handles.length > 1) {
          // 找到下一个句柄设为活跃
          const nextHandle = handles.find(h => h.id !== handleToRemove.id);
          if (nextHandle) {
            await ctx.database.set('sc2arcade_player', { id: nextHandle.id }, { isActive: true });
            return `<quote id="${session.messageId}"/>✅ 已解绑句柄，并自动切换到：${formatHandle(nextHandle)}`;
          }
        }

        return `<quote id="${session.messageId}"/>✅ 已成功解绑句柄。`;
      } catch (error) {
        console.error('解绑失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.guild()
    .command('sc2arcade/解绑地图', '解绑游戏大厅地图', { authority: 3 })
    .action(async (argv) => {
      const session = argv.session;

      try {
        const existingRecord = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });
        if (Object.keys(existingRecord).length < 1) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        await ctx.database.remove('sc2arcade_map', { guildId: session.guildId });
        return `<quote id="${session.messageId}"/>✅ 本群已成功解绑游戏大厅地图。`;
      } catch (error) {
        console.error('解绑失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.guild()
    .command('sc2arcade/更新日志')
    .action(async (argv) => {
      try {
        const session = argv.session;
        const mapRecords = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });

        if (!mapRecords || mapRecords.length === 0) {
          return `<quote id="${session.messageId}"/>本群暂未绑定游戏大厅地图, 请联系管理员。`;
        }

        const [mapRecord] = mapRecords; // 解构赋值获取第一个元素
        const { regionId, mapId } = mapRecord; // 解构赋值提取属性
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/maps/${regionId}/${mapId}/details?locale=zhCN`,
          config.proxyAgent
        );

        const data = response.data // 根据实际响应结构调整

        // 提取补丁说明
        const patchNotes = data.info.arcadeInfo.patchNoteSections

        if (!patchNotes || !patchNotes.length) {
          return '暂无更新日志。'
        }

        // 按日期降序排序
        const sortedNotes = patchNotes.sort((a, b) => {
          const parseDate = (str: string) => {
            return new Date(str.replace('年', '-').replace('月', '-').replace('日', ''))
          }
          return parseDate(b.subtitle).getTime() - parseDate(a.subtitle).getTime()
        })

        // 修改后的代码片段：
        const messages = []
        messages.push('🚀 最新更新日志: \n') // 不需要首行空行

        sortedNotes.forEach(note => {
          messages.push(
            `▛ ${note.title} - ${note.subtitle} ▜`,
            ...note.items
              .filter(item => typeof item === 'string')
              .map(item => item.trim())
              .filter(item => item !== ''), // 严格过滤空行
            '' // 保留补丁之间的分隔空行
          )
        })

        // 移除最后一个多余的空行
        if (messages[messages.length - 1] === '') {
          messages.pop()
        }

        return messages.join('\n')

      } catch (error) {
        console.error('查询更新日志发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  // 创建测试指令
  ctx.command('sc2arcade/sensitive <text>', '检测文本是否包含敏感词', { authority: 3 })
    .action(async ({ session }, text) => {
      if (!text) return '请输入要检测的文本内容'

      // 调用检测函数
      const isSensitive = await checkSensitiveWord(ctx, config, text)

      // 返回结果
      if (isSensitive) {
        return `检测结果: ❌ 包含敏感词\n文本: ${text}`
      } else {
        return `检测结果: ✅ 无敏感词\n文本: ${text}`
      }
    })

}

function profilesMatches(session: any, response: any) {
  const data = response.data.results;

  const decisionTranslate = (decision) => {
    const translations = {
      left: '🚶 离开',
      win: '🎉 胜利',
      loss: '😞 失败',
      tie: '🤝 平局'
    };
    return translations[decision] || decision;
  };

  // 核心修复：只在消息开头加一次引用
  const header = `<quote id="${session.messageId}"/>对局记录：\n`;

  // 格式化每条记录
  const matchList = data.map((match, index) =>
    `${index + 1}. 地图: ${match.map.name}, 结果: ${decisionTranslate(match.decision)}`
  ).join('\n');

  // 完整消息：引用+所有记录
  return header + matchList;
}

function profilesMostPlayed(session: any, response: any) {
  const data = response.data;

  const topMaps = data
    .filter(item => item.lobbiesStarted > 0)
    .sort((a, b) => b.lobbiesStarted - a.lobbiesStarted)
    .slice(0, 10)
    .map((item, index) =>
      `${index + 1}. 地图: ${item.map.name}, 游戏场数: ${item.lobbiesStarted}`
    )
    .join('\n');

  // 简洁版：只在消息开头添加一次引用
  return `<quote id="${session.messageId}"/>最常玩的地图排行：\n${topMaps}`;
}

// 独立的日期时间格式转换函数
function convertDateTimeFormat(dateString) {
  const date = new Date(dateString);
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function mapsplayerbase(response) {
  const data = response.data.results;

  const topPlayers = data
    .filter(item => item.lobbiesStarted > 0)
    .sort((a, b) => b.lobbiesStarted - a.lobbiesStarted)
    .map((item, index) => `${index + 1}. 玩家: ${item.profile.name}, 游戏场数: ${item.lobbiesStarted}`)
    .join('\n');

  return topPlayers;
}

// 修改 lobbiesActive 函数
function lobbiesActive(response: any, regionName: string) {
  const data = response.data;

  // 如果数据为空数组，返回特定服务器名称的提示
  if (!data.length) return `🚪 当前${regionName}游戏大厅暂无房间。`;

  // 限制数据条数，格式化并连接数据
  const roomList = data.slice(0, 20).map((item, index) =>
    `${index + 1}. 地图: ${item.map.name}, 人数: ${item.slotsHumansTaken}/${item.slotsHumansTotal}`
  ).join('\n');

  return `${regionName}游戏大厅房间列表：\n${roomList}`;
}

// 封装 HTTP 请求函数
async function makeHttpRequest(ctx: Context, url: string, proxyAgent?: string) {
  const config = proxyAgent ? { proxyAgent } : undefined;
  return await ctx.http('get', url, config);
}

// 封装敏感词查询为一个独立的函数
async function checkSensitiveWord(ctx: Context, config: Config, content: string): Promise<boolean> {

  // 如果禁用敏感词检测，直接返回 false
  if (!config.sensitiveword) {
    return false
  }

  // 优先检查数据库缓存
  const [record] = await ctx.database.get('sc2arcade_sensitiveword', { name: content });

  // 如果存在缓存记录，直接返回缓存结果（不再检查时间）
  if (record) {
    return record.isSensitive;
  }

  try {
    // 调用新的敏感词检查 API (POST)
    const response = await ctx.http.post(
      'https://uapis.cn/api/v1/text/profanitycheck',
      { text: content }, // 直接使用原始文本，不需要encodeURIComponent
    );

    // 解析 API 响应
    const isSensitive = response.status === "forbidden";

    // 将结果存入数据库缓存（首次存储）
    await ctx.database.upsert('sc2arcade_sensitiveword', [{
      name: content,
      isSensitive,
      lastdate: new Date(),
    }]);

    return isSensitive;
  } catch (error) {
    console.error('敏感词检查失败:', error);
    // 出错时返回安全值（认为有敏感词）
    return true;
  }
}

async function lobbiesHistory(ctx: Context, config: Config, response, status: string) {
  const rooms = response.data.results
    .filter(room => room.status === status && room.slotsHumansTaken > 0)
    .slice(0, status === 'started' ? 5 : 20);

  // 根据状态返回不同的提示信息
  if (!rooms.length) {
    return status === 'started'
      ? '🚪 当前地图暂无历史房间。'
      : '🚪 当前地图暂无等待中的房间。';
  }

  // 批量处理所有玩家名称
  const processSlots = async (slots) => {
    return Promise.all(slots.map(async (slot) => {
      const displayName = await checkSensitiveWord(ctx, config, slot.name)
        ? `${slot.name[0] || ''}***`
        : slot.name;
      return `  ${slot.slotNumber}. ${displayName}`;
    }));
  };

  const roomMessages = await Promise.all(rooms.map(async (room, index) => {
    const humanSlots = room.slots
      .filter(slot => slot.kind === 'human')
      .sort((a, b) => a.slotNumber - b.slotNumber);

    const slotList = await processSlots(humanSlots);
    return [
      `🚪 房间 ${index + 1}: ${room.slotsHumansTaken}/${room.slotsHumansTotal}`,
      `创建时间: ${convertDateTimeFormat(room.createdAt)}`,
      ...slotList,
    ].join('\n');
  }));

  return roomMessages.join('\n\n');
}
