package com.hatem.musicmute.ui.design

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.Checkbox
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.SheetValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconToggleButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics

@Composable
fun CreativePage(
    modifier: Modifier = Modifier,
    scrollable: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(modifier.fillMaxSize().imePadding(), contentAlignment = Alignment.TopCenter) {
        val scroll = if (scrollable) Modifier.verticalScroll(rememberScrollState()) else Modifier
        Column(
            Modifier.widthIn(max = CreativeTokens.ContentWidth).fillMaxWidth()
                .then(scroll).padding(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap),
            content = content,
        )
    }
}

@Composable
fun CreativeHeader(title: String, subtitle: String? = null, wave: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
        Text(title, modifier = Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineLarge)
        subtitle?.let {
            Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (wave) CreativeWave(Modifier.fillMaxWidth())
    }
}

@Composable
fun CreativeCard(
    modifier: Modifier = Modifier,
    contentPadding: Dp = CreativeTokens.CardPadding,
    contentGap: Dp = CreativeTokens.ContentGap,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(contentPadding),
            verticalArrangement = Arrangement.spacedBy(contentGap),
            content = content,
        )
    }
}

@Composable
fun CreativePrimaryButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    destructive: Boolean = false,
    content: @Composable RowScope.() -> Unit,
) {
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val motion = rememberCreativeMotionEnabled()
    val scale by animateFloatAsState(
        if (pressed && enabled && !busy && motion) CreativeMotion.PRESSED_SCALE else 1f,
        tween(if (motion) CreativeMotion.PRESS_MS else 0, easing = CreativeMotion.Ease), label = "button-press",
    )
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = CreativeTokens.TouchTarget).graphicsLayer { scaleX = scale; scaleY = scale },
        enabled = enabled && !busy,
        interactionSource = interactions,
        shape = MaterialTheme.shapes.medium,
        colors = if (destructive) ButtonDefaults.buttonColors(
            containerColor = MaterialTheme.colorScheme.error,
            contentColor = MaterialTheme.colorScheme.onError,
        ) else ButtonDefaults.buttonColors(),
    ) {
        if (busy) CircularProgressIndicator(
            Modifier.padding(end = CreativeTokens.CompactGap).size(CreativeTokens.InlineProgress),
            strokeWidth = CreativeTokens.ProgressStroke,
        )
        content()
    }
}

@Composable
fun CreativeTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    error: String? = null,
    singleLine: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    trailingIcon: (@Composable () -> Unit)? = null,
) {
    OutlinedTextField(
        value, onValueChange, modifier.fillMaxWidth(), enabled = enabled,
        label = { Text(label) }, isError = error != null,
        supportingText = error?.let { { Text(it) } }, singleLine = singleLine,
        shape = MaterialTheme.shapes.medium, visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, trailingIcon = trailingIcon,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreativeSheet(onDismiss: () -> Unit, dismissible: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
    val canDismiss by rememberUpdatedState(dismissible)
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { it != SheetValue.Hidden || canDismiss })
    // Material owns focus, back/swipe gestures and animation-scale handling.
    ModalBottomSheet(
        onDismissRequest = { if (canDismiss) onDismiss() },
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.large,
    ) {
        Column(
            Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState())
                .padding(CreativeTokens.PagePadding),
            verticalArrangement = Arrangement.spacedBy(CreativeTokens.ContentGap),
            content = content,
        )
    }
}

@Composable
fun CreativeFeedback(
    message: String,
    modifier: Modifier = Modifier,
    error: Boolean = false,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(modifier.semantics { liveRegion = LiveRegionMode.Polite },
        verticalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap)) {
        Text(message, color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        if (actionLabel != null && onAction != null) TextButton(onClick = onAction) { Text(actionLabel) }
    }
}

/** A single labelled checkbox target, including its wrapping consent text. */
@Composable
fun CreativeConsentRow(checked: Boolean, onCheckedChange: (Boolean) -> Unit, label: String, enabled: Boolean = true) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = CreativeTokens.TouchTarget)
            .toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onCheckedChange)
            .padding(vertical = CreativeTokens.CompactGap),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(CreativeTokens.CompactGap),
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Text(label, Modifier.weight(1f), color = MaterialTheme.colorScheme.onSurface.copy(
            alpha = if (enabled) 1f else CreativeTokens.DisabledAlpha,
        ))
    }
}

@Composable
fun CreativeStarButton(starred: Boolean, onClick: () -> Unit, description: String, modifier: Modifier = Modifier) {
    val scale = remember { Animatable(1f) }
    val motion = rememberCreativeMotionEnabled()
    var first by remember { androidx.compose.runtime.mutableStateOf(true) }
    LaunchedEffect(starred, motion) {
        if (!first && motion) {
            scale.animateTo(1.1f, tween(CreativeMotion.STAR_MS / 2, easing = CreativeMotion.Ease))
            scale.animateTo(1f, tween(CreativeMotion.STAR_MS / 2, easing = CreativeMotion.Ease))
        } else scale.snapTo(1f)
        first = false
    }
    IconToggleButton(checked = starred, onCheckedChange = { onClick() }, modifier = modifier) {
        Icon(
            if (starred) Icons.Filled.Star else Icons.Outlined.StarBorder,
            contentDescription = description,
            tint = if (starred) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value },
        )
    }
}
