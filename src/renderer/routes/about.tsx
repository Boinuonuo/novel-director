import { Anchor, Container, Flex, Image, Stack, Text, Title } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import { createFileRoute, useCanGoBack, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { IconButton } from '@/components/common/IconButton'
import Page from '@/components/layout/Page'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import useVersion from '@/hooks/useVersion'
import iconPNG from '@/static/icon.png'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

/** What the app is, and the notices GPL-3.0 asks an interactive program to show. */
export function AboutDetails() {
  const { t } = useTranslation()
  return (
    <Stack gap="xxs">
      <Text>{t('Write long novels together with AI.')}</Text>
      <Text c="chatbox-tertiary">
        {t('One conversation is one novel. The world, characters and foreshadowing are kept in the background.')}
      </Text>
      <Text size="xs" c="chatbox-tertiary">
        Copyright (C) 2026{' '}
        <Anchor inherit href="https://github.com/Boinuonuo" target="_blank" underline="always" c="chatbox-tertiary">
          Boinuonuo
        </Anchor>
        {'. '}
        {t('Free software under GPL-3.0, with ABSOLUTELY NO WARRANTY.')}
      </Text>
      <Flex gap="sm">
        <Anchor
          size="xs"
          href="https://github.com/Boinuonuo/novel-director"
          target="_blank"
          underline="hover"
          c="chatbox-tertiary"
        >
          {t('Source code')}
        </Anchor>
        <Anchor
          size="xs"
          href="https://github.com/chatboxai/chatbox"
          target="_blank"
          underline="hover"
          c="chatbox-tertiary"
        >
          {t('Modified from the open-source project Chatbox since November 2026')}
        </Anchor>
      </Flex>
    </Stack>
  )
}

function RouteComponent() {
  const { t } = useTranslation()
  const version = useVersion()
  const isSmallScreen = useIsSmallScreen()
  const router = useRouter()
  const canGoBack = useCanGoBack()

  const goBack = useCallback(() => {
    if (canGoBack) router.history.back()
    else void router.navigate({ to: '/' })
  }, [canGoBack, router])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') goBack()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBack])

  return (
    <Page title={t('About')} left={<IconButton icon={IconArrowLeft} aria-label={t('Back')} onClick={goBack} />}>
      <Container size="md" p={0}>
        <Stack gap="xxl" px={isSmallScreen ? 'sm' : 'md'} py={isSmallScreen ? 'xl' : 'md'}>
          <Flex gap="xxl" p="md" className="rounded-lg bg-chatbox-background-secondary">
            <Image h={100} w={100} mah={'20vw'} maw={'20vw'} src={iconPNG} />
            <Stack flex={1} gap="xxs">
              <Title order={5} lh={1.5} lineClamp={1}>
                Novel Director {/\d/.test(version.version) ? `(v${version.version})` : ''}
              </Title>
              <AboutDetails />
            </Stack>
          </Flex>
        </Stack>
      </Container>
    </Page>
  )
}
