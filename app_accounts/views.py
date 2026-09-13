from django.contrib.auth import login
from django.contrib.auth.forms import AuthenticationForm, UserCreationForm
from django.contrib.auth.views import LoginView, LogoutView
from django.shortcuts import redirect, render
from django.urls import reverse_lazy
from django.views import View
from django.views.decorators.http import require_POST
from django.utils.decorators import method_decorator


class SignUpView(View):
    template_name = 'app_accounts/signup.html'

    def get(self, request):
        if request.user.is_authenticated:
            return redirect('viewer:index')
        return render(request, self.template_name, {'form': UserCreationForm()})

    def post(self, request):
        form = UserCreationForm(request.POST)
        if form.is_valid():
            user = form.save()
            login(request, user)
            return redirect('viewer:index')
        return render(request, self.template_name, {'form': form})


class SignInView(LoginView):
    template_name = 'app_accounts/login.html'
    redirect_authenticated_user = True
    authentication_form = AuthenticationForm


@method_decorator(require_POST, name='dispatch')
class SignOutView(LogoutView):
    next_page = reverse_lazy('accounts:login')
