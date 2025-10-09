import { Context, Schema, h } from 'koishi'

import '@koishijs/plugin-proxy-agent'

export const name = 'sc2arcade-search'

export interface Config {
  proxyAgent: string
}

export const Config: Schema<Config> = Schema.object({
  proxyAgent: Schema.string().description('代理服务器地址')
})

export const inject = {
  required: ['database'],
}

declare module 'koishi' {
  interface Tables {
    sc2arcade_player: player
    sc2arcade_map: map
    sc2arcade_sensitive_names: sensitiveName // 新增敏感词表
  }
}

// 这里是新增表的接口类型
export interface player {
  userId: string
  regionId: number
  realmId: number
  profileId: number
  createdAt: Date
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
    userId: 'string',
    regionId: 'unsigned',
    realmId: 'unsigned',
    profileId: 'unsigned',
    createdAt: 'timestamp',
  }, {
    primary: 'userId'
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
  ctx.model.extend('sc2arcade_sensitive_names', {
    name: 'string',
    isSensitive: 'boolean',
    lastdate: 'timestamp',
  }, {
    primary: 'name' // 使用name作为主键
  })

  ctx.guild()
    .command('sc2arcade/房间', '查询本群绑定的游戏大厅地图正在等待中的房间')
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
    .command('sc2arcade/历史房间', '查询本群绑定的游戏大厅地图已经开始的房间')
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
    .command('sc2arcade/场数排行', '查询本群绑定的游戏大厅地图的玩家总场数排行榜')
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

  ctx.command('sc2arcade/大厅 [regionId]', '查询指定区域正在等待中的房间')
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


      // 映射区域ID到区域代码
      const regionCodeMap = { US: 1, EU: 2, KR: 3, CN: 5 };
      const regionCode = regionCodeMap[regionId.toUpperCase()];

      try {
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/lobbies/active?regionId=${regionCode}&includeMapInfo=true`,
          config.proxyAgent
        );

        return await lobbiesActive(response);
      } catch (error) {
        console.error('查询大厅信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.command('sc2arcade/句柄 [user]', '查询用户绑定的游戏句柄')
    .usage('user 参数为选填项')
    .example('/句柄, 查询自己绑定的游戏句柄\n    /句柄 @用户, 查询其他用户绑定的游戏句柄')
    .action(async (argv, user) => {
      const session = argv.session; // 获取 Session 对象
      try {
        if (!user) {
          const [profile] = await ctx.database.get('sc2arcade_player', { userId: session.userId });

          if (!profile) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
          }

          const { regionId, realmId, profileId } = profile;
          return `<quote id="${session.messageId}"/>您绑定的游戏句柄为 ${regionId}-S2-${realmId}-${profileId}`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"句柄 @用户"查询其他用户绑定的游戏句柄。`
          }
          const targetUserId = parsedUser.attrs.id;

          const [profile] = await ctx.database.get('sc2arcade_player', { userId: targetUserId });

          if (!profile) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄。`;
          }

          const { regionId, realmId, profileId } = profile;
          return `<quote id="${session.messageId}"/>对方绑定的游戏句柄为 ${regionId}-S2-${realmId}-${profileId}`;
        }

      } catch (error) {
        console.error('查询句柄信息时发生错误:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.command('sc2arcade/查询 [handle]', '查询游戏句柄是否被用户绑定')
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

  ctx.command('sc2arcade/战绩 [user]', '查询用户的游戏战绩')
    .usage('user 参数为选填项')
    .example('/战绩, 查询自己的游戏战绩\n    /战绩 @用户, 查询其他用户的游戏战绩')
    .action(async (argv, user) => {
      const session = argv.session; // 获取Session对象
      let regionId, realmId, profileId;
      try {
        if (!user) {
          const [profile] = await ctx.database.get('sc2arcade_player', { userId: session.userId });
          if (!profile) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
          }
          ({ regionId, realmId, profileId } = profile);
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
          const [profile] = await ctx.database.get('sc2arcade_player', { userId: targetUserId });
          if (!profile) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄。`;
          }
          ({ regionId, realmId, profileId } = profile);
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

  ctx.command('sc2arcade/场数 [user]', '查询用户游玩的所有地图的​​累计场数排行榜')
    .alias('场次')
    .usage('user 参数为选填项')
    .example('/场数, 查询自己游玩的所有地图的​​累计场数排行榜\n    /场数 @用户, 查询其他用户游玩的所有地图的​​累计场数排行榜')
    .action(async (argv, user) => {
      const session = argv.session; // 获取Session对象
      let regionId, realmId, profileId;
      try {
        if (!user) {
          const [profile] = await ctx.database.get('sc2arcade_player', { userId: session.userId });
          if (!profile) {
            return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
          }
          ({ regionId, realmId, profileId } = profile);
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的​​场数。`;
        } else {
          const parsedUser = h.parse(user)[0];
          if (!parsedUser || parsedUser.type !== 'at' || !parsedUser.attrs.id) {
            return `<quote id="${session.messageId}"/>❌ 参数错误, 请输入"场数 @用户"查询其他用户游玩的所有地图的​​累计场数排行榜。`
          }
          const targetUserId = parsedUser.attrs.id;
          const [profile] = await ctx.database.get('sc2arcade_player', { userId: targetUserId });
          if (!profile) {
            return `<quote id="${session.messageId}"/>对方暂未绑定游戏句柄。`;
          }
          ({ regionId, realmId, profileId } = profile);
          const response = await makeHttpRequest(
            ctx,
            `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}/most-played`,
            config.proxyAgent
          );
          const history = profilesMostPlayed(session, response);
          return history && history.length > 0 ? history : `<quote id="${session.messageId}"/>📭 该游戏账号没有可查询的​​场数。`;
        }
      } catch (error) {
        console.error('查询游戏场数失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.command('sc2arcade/绑定 [handle]', '绑定游戏句柄')
    .alias('绑定句柄')
    .usage('游戏句柄格式为: [区域ID]-S2-[服务器ID]-[档案ID]')
    .action(async (argv, handle) => {
      const session = argv.session; // 获取 Session 对象
      // 检查用户是否已绑定
      const existingRecord = await ctx.database.get('sc2arcade_player', { userId: session.userId });
      if (Object.keys(existingRecord).length > 0) {
        return `<quote id="${session.messageId}"/>您已经绑定了游戏句柄, 无需再次绑定。`;
      }
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
        return `<quote id="${session.messageId}"/>❌ 绑定失败, 该游戏句柄已被 ${existingHandle[0].userId} 绑定。`;
      }

      try {
        // 查询句柄信息
        const response = await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/profiles/${regionId}/${realmId}/${profileId}`,
          config.proxyAgent
        );

        // 执行绑定操作
        await ctx.database.create('sc2arcade_player', {
          userId: session.userId,
          regionId,
          realmId,
          profileId,
          createdAt: new Date()
        });

        return `<quote id="${session.messageId}"/>✅ 您已经成功绑定到该游戏句柄。`;

      } catch (error) {
        // 如果请求本身失败（比如网络问题），会进入catch块
        if (error.response && error.response.status === 404) {
          return `<quote id="${session.messageId}"/>❌ 绑定失败, 您尝试绑定的游戏句柄不存在。`;
        }
        console.error('查询或绑定失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.command('sc2arcade/解绑', '解绑游戏句柄')
    .alias('解绑句柄')
    .action(async (argv) => {
      const session = argv.session; // 获取 Session 对象

      try {
        // 检查并删除绑定
        const existingRecord = await ctx.database.get('sc2arcade_player', { userId: session.userId });
        if (Object.keys(existingRecord).length < 1) {
          return `<quote id="${session.messageId}"/>您暂未绑定游戏句柄。`;
        }
        await ctx.database.remove('sc2arcade_player', { userId: session.userId });
        return `<quote id="${session.messageId}"/>✅ 您已成功解绑游戏句柄。`;
      } catch (error) {
        console.error('解绑失败:', error);
        return '⚠️ 服务器繁忙, 请稍后尝试。';
      }
    });

  ctx.guild()
    .command('sc2arcade/绑定地图 [url]', '绑定游戏大厅地图', { authority: 3 })
    .usage('地图URL格式为: https://sc2arcade.com/map/[区域ID]/[地图ID]/')
    .action(async (argv, url) => {
      const session = argv.session;

      const existingRecord = await ctx.database.get('sc2arcade_map', { guildId: session.guildId });
      if (Object.keys(existingRecord).length > 0) {
        return `<quote id="${session.messageId}"/>本群已经绑定了游戏大厅地图, 无需再次绑定。`;
      }

      if (!url) {
        await session.send(`<quote id="${session.messageId}"/>请在30秒内输入游戏大厅的地图URL:\n(地图URL格式为: https://sc2arcade.com/map/[区域ID]/[地图ID]/)`)

        url = await session.prompt(30000)
        if (!url) return `<quote id="${session.messageId}"/>已取消操作, 请重新输入。`
      }

      const regex = /^https:\/\/sc2arcade\.com\/map\/(\d)\/(\d+)\/$/;
      const [, regionId, mapId] = url.match(regex)?.map(Number) || [];

      if (!regionId || !mapId) {
        return `<quote id="${session.messageId}"/>❌ 地图URL格式错误, 请重新输入。\n(地图URL格式为: https://sc2arcade.com/map/[区域ID]/[地图ID]/)`;
      }

      try {
        await makeHttpRequest(
          ctx,
          `https://api.sc2arcade.com/maps/${regionId}/${mapId}`,
          config.proxyAgent
        );

        await ctx.database.create('sc2arcade_map', {
          guildId: session.guildId,
          regionId,
          mapId,
          createdAt: new Date()
        });

        return `<quote id="${session.messageId}"/>✅ 本群已成功绑定到该游戏大厅地图。`;
      } catch (error) {
        // 处理404错误（兼容不同HTTP客户端实现）
        if (error.response?.status === 404) {
          return `<quote id="${session.messageId}"/>❌ 绑定失败, 本群尝试绑定的游戏大厅地图不存在。`;
        }

        console.error('地图绑定失败:', error);
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

function lobbiesActive(response: any) {
  const data = response.data;

  // 如果数据为空数组，返回'大厅无房间'
  if (!data.length) return '🚪 当前游戏大厅暂无房间。';

  // 限制数据条数，格式化并连接数据
  return data.slice(0, 20).map((item, index) =>
    `${index + 1}. 地图: ${item.map.name}, 人数: ${item.slotsHumansTaken}/${item.slotsHumansTotal}`
  ).join('\n');
}

// 封装 HTTP 请求函数
async function makeHttpRequest(ctx: Context, url: string, proxyAgent?: string) {
  const config = proxyAgent ? { proxyAgent } : undefined;
  return await ctx.http('get', url, config);
}

// 封装敏感词查询为一个独立的函数
async function checkSensitiveWord(ctx: Context, config: Config, content: string): Promise<boolean> {
  const CACHE_EXPIRY_DAYS = 7;
  const expiryTime = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  // 优先检查数据库缓存
  const [record] = await ctx.database.get('sc2arcade_sensitive_names', { name: content });

  if (record) {
    const now = Date.now();
    const recordDate = new Date(record.lastdate).getTime();
    if (now - recordDate <= expiryTime) {
      return record.isSensitive;
    }
  }

  try {
    // 调用敏感词检查 API
    const response = await ctx.http.get(
      `https://v.api.aa1.cn/api/api-mgc/index.php?msg=${encodeURIComponent(content)}`,
      { proxyAgent: config.proxyAgent }
    );

    // 解析 API 响应
    const isSensitive = response.code === 200 &&
      (response.num === '1' || response.desc.includes('存在敏感词'));

    // 更新数据库缓存
    await ctx.database.upsert('sc2arcade_sensitive_names', [{
      name: content,
      isSensitive,
      lastdate: new Date(),
    }]);

    return isSensitive;
  } catch (error) {
    console.error('敏感词检查失败, 使用缓存或默认值:', error);
    return record?.isSensitive || false;
  }
}

async function lobbiesHistory(ctx: Context, config: Config, response, status: string) {
  const rooms = response.data.results
    .filter(room => room.status === status && room.slotsHumansTaken > 0)
    .slice(0, status === 'started' ? 5 : 20);

  if (!rooms.length) return '🚪 当前游戏大厅暂无房间。';

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
