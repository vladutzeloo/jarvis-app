package com.jarvis.localchat.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7AC7FF),
    onPrimary = Color(0xFF00344F),
    background = Color(0xFF0B0F14),
    surface = Color(0xFF111820),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF0066B2),
    background = Color(0xFFF7F9FB),
    surface = Color(0xFFFFFFFF),
)

@Composable
fun JarvisTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) DarkColors else LightColors
    MaterialTheme(colorScheme = scheme, content = content)
}
