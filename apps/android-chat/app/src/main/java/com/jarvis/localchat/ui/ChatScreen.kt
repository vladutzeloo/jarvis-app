package com.jarvis.localchat.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.jarvis.localchat.llm.ChatTemplate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: ChatViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    val listState = rememberLazyListState()

    val pickModel = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? -> uri?.let(vm::importModel) }

    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) {
            listState.animateScrollToItem(state.messages.size - 1)
        }
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("JARVIS · local", fontWeight = FontWeight.SemiBold)
                        state.modelName?.let {
                            Text(
                                it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                actions = {
                    TextButton(onClick = vm::clearChat) { Text("Clear") }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(MaterialTheme.colorScheme.background),
        ) {
            state.importProgress?.let { p ->
                LinearProgressIndicator(
                    progress = { p },
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (state.modelName == null) {
                NoModelState(
                    isLoading = state.isModelLoading || state.importProgress != null,
                    onPick = { pickModel.launch(arrayOf("*/*")) },
                    modifier = Modifier.weight(1f),
                )
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(state.messages) { msg -> MessageBubble(msg) }
                }
            }

            state.error?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }

            InputBar(
                draft = state.draft,
                enabled = state.modelName != null && !state.isGenerating,
                isGenerating = state.isGenerating,
                onChange = vm::setDraft,
                onSend = vm::send,
                onStop = vm::stop,
            )
        }
    }
}

@Composable
private fun NoModelState(
    isLoading: Boolean,
    onPick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("No model loaded", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Pick a GGUF file from your device. We recommend " +
                "Llama-3.2-1B-Instruct-Q4_K_M (~770 MB).",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = onPick, enabled = !isLoading) {
            Text(if (isLoading) "Loading…" else "Select model file")
        }
    }
}

@Composable
private fun MessageBubble(msg: Message) {
    val isUser = msg.role == ChatTemplate.Role.USER
    val bg = if (isUser) MaterialTheme.colorScheme.primary
             else MaterialTheme.colorScheme.surface
    val fg = if (isUser) MaterialTheme.colorScheme.onPrimary
             else MaterialTheme.colorScheme.onSurface

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Surface(
            color = bg,
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.widthIn(max = 320.dp),
        ) {
            Text(
                text = msg.text.ifEmpty { "…" },
                color = fg,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun InputBar(
    draft: String,
    enabled: Boolean,
    isGenerating: Boolean,
    onChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Surface(tonalElevation = 2.dp) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = draft,
                onValueChange = onChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message JARVIS") },
                enabled = enabled || isGenerating,
                singleLine = false,
                maxLines = 5,
            )
            Spacer(Modifier.padding(4.dp))
            if (isGenerating) {
                Button(onClick = onStop) { Text("Stop") }
            } else {
                Button(onClick = onSend, enabled = enabled && draft.isNotBlank()) {
                    Text("Send")
                }
            }
        }
    }
}
